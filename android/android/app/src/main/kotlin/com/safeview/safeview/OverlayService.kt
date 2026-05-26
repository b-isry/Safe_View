// SafeView — OverlayService.kt
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Foreground service with MediaProjection capture and WindowManager overlay.

package com.safeview.safeview

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.PixelFormat
import android.media.AudioManager
import android.media.Image
import android.media.ImageReader
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service (mediaProjection type) that captures screen frames at ≤2 FPS,
 * posts JPEGs to FastAPI, and shows a full-screen overlay on BLUR.
 */
class OverlayService : Service() {

    companion object {
        private const val TAG = "SafeView"
        private const val CHANNEL_ID = "safeview_overlay"
        private const val NOTIFICATION_ID = 1001
        private const val STOP_ACTION_REQUEST_CODE = 2001

        const val EXTRA_SENSITIVITY = "sensitivity"
        const val EXTRA_CATEGORIES = "categories"
        const val EXTRA_BACKEND_URL = "backend_url"
        const val EXTRA_PROJECTION_RESULT_CODE = "projection_result_code"
        const val EXTRA_PROJECTION_DATA = "projection_data"
        const val EXTRA_AUDIO_LANGUAGE = "audio_language"
        const val EXTRA_PROFANITY_WORDS = "profanity_words"
        const val ACTION_STOP = "com.safeview.safeview.STOP_PROTECTION"

        /** Vision categories sent to /analyze-image. */
        private val VISION_CATEGORIES = listOf("nudity", "violence")

        /** BR-05 profanity mute on Android (no delay vault). */
        private const val ANDROID_PROFANITY_MUTE_MS = 1500L
    }

    private var windowManager: WindowManager? = null
    private var overlayView: OverlayView? = null
    private var captureHelper: ScreenCaptureHelper? = null
    private var audioCaptureHelper: AudioPlaybackCaptureHelper? = null

    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var networkExecutor: ExecutorService? = null

    private var sensitivity: Float = 0.75f
    private var backendUrl: String = "http://10.0.2.2:8000"
    private var visionCategories: List<String> = listOf("nudity")
    private var profanityEnabled: Boolean = false
    private var audioLanguage: String = "en"
    private var profanityWords: List<String> = emptyList()

    private val audioManager: AudioManager by lazy {
        getSystemService(AUDIO_SERVICE) as AudioManager
    }
    private var toneGenerator: ToneGenerator? = null
    private var profanityMuteRestoreRunnable: Runnable? = null

    private var lastSampleElapsedMs: Long = 0L
    private val isAudioAnalyzing = AtomicBoolean(false)
    private val isAnalyzing = AtomicBoolean(false)
    private val overlayVisible = AtomicBoolean(false)

    private val imageAvailableListener = ImageReader.OnImageAvailableListener { reader ->
        onFrameAvailable(reader)
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        captureHelper = ScreenCaptureHelper(this)
        audioCaptureHelper = AudioPlaybackCaptureHelper(this)
        networkExecutor = Executors.newSingleThreadExecutor()
        if (toneGenerator == null) {
            toneGenerator = ToneGenerator(AudioManager.STREAM_MUSIC, 80)
        }
        OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_STARTED)
        Log.i(TAG, "OverlayService created — foreground notification active")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_STOPPED)
            shutdown()
            return START_NOT_STICKY
        }

        sensitivity = intent?.getFloatExtra(EXTRA_SENSITIVITY, 0.75f) ?: 0.75f
        backendUrl = intent?.getStringExtra(EXTRA_BACKEND_URL) ?: "http://10.0.2.2:8000"
        val requestedCategories =
            intent?.getStringArrayListExtra(EXTRA_CATEGORIES) ?: arrayListOf("nudity")
        profanityEnabled = requestedCategories.contains("profanity")
        visionCategories = requestedCategories
            .filter { VISION_CATEGORIES.contains(it) }
            .ifEmpty { listOf("nudity") }
        audioLanguage = intent?.getStringExtra(EXTRA_AUDIO_LANGUAGE)?.lowercase() ?: "en"
        profanityWords = intent?.getStringArrayListExtra(EXTRA_PROFANITY_WORDS) ?: emptyList()

        val resultCode = intent?.getIntExtra(EXTRA_PROJECTION_RESULT_CODE, -1) ?: -1
        @Suppress("DEPRECATION")
        val projectionData: Intent? = intent?.getParcelableExtra(EXTRA_PROJECTION_DATA)

        if (resultCode != -1 && projectionData != null) {
            startCapture(resultCode, projectionData)
        } else {
            Log.w(TAG, "OverlayService started without MediaProjection consent extras")
        }

        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
        Log.i(TAG, "OverlayService destroyed")
    }

    /**
     * Starts MediaProjection + VirtualDisplay + ImageReader on a background thread.
     */
    private fun startCapture(resultCode: Int, projectionData: Intent) {
        stopCapturePipeline()

        captureThread = HandlerThread("SafeViewCapture").apply { start() }
        captureHandler = Handler(captureThread!!.looper)

        if (profanityEnabled) {
            captureHelper?.startProjectionOnly(
                resultCode = resultCode,
                data = projectionData,
                handler = captureHandler!!,
            )
            Log.i(TAG, "Audio-priority mode — screen frame capture disabled (CPU guard)")
        } else {
            captureHelper?.start(
                resultCode = resultCode,
                data = projectionData,
                handler = captureHandler!!,
                onImageAvailable = imageAvailableListener,
            )
        }
        lastSampleElapsedMs = 0L
        OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_CAPTURING)
        startAudioProfanityCaptureIfNeeded()
        Log.i(
            TAG,
            "Capture pipeline started url=$backendUrl vision=$visionCategories profanity=$profanityEnabled",
        )
    }

    /**
     * Start AudioPlaybackCapture when profanity filter is enabled (API 29+).
     */
    private fun startAudioProfanityCaptureIfNeeded() {
        if (!profanityEnabled) {
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            Log.w(TAG, "Profanity audio requires API 29+")
            return
        }

        val projection = captureHelper?.getMediaProjection()
        if (projection == null) {
            Log.w(TAG, "MediaProjection unavailable — profanity audio not started")
            return
        }

        audioCaptureHelper?.start(projection) { wavBytes ->
            if (!isAudioAnalyzing.compareAndSet(false, true)) {
                return@start
            }
            networkExecutor?.execute {
                try {
                    analyzeAudioChunk(wavBytes)
                } finally {
                    isAudioAnalyzing.set(false)
                }
            }
        }
    }

    /**
     * POST a WAV chunk to /analyze-audio; mute playback + beep on MUTE (BR-05).
     */
    private fun analyzeAudioChunk(wavBytes: ByteArray) {
        val response = BackendApiClient.analyzeAudio(
            baseUrl = backendUrl,
            audioBytes = wavBytes,
            language = audioLanguage,
            sensitivity = sensitivity,
            profanityWords = profanityWords,
            audioFormat = "wav",
        ) ?: return

        if (!response.shouldMute) {
            return
        }

        Log.i(TAG, "Profanity detected in playback audio — muting for ${ANDROID_PROFANITY_MUTE_MS}ms")
        applyProfanityMuteAndBeep()
        OverlayEventBridge.emitDetection(
            detected = true,
            category = "profanity",
            fromFallback = false,
        )
    }

    /**
     * Mute STREAM_MUSIC and play a short beep (lightweight BR-05, no delay vault).
     */
    private fun applyProfanityMuteAndBeep() {
        mainHandler.post {
            profanityMuteRestoreRunnable?.let { mainHandler.removeCallbacks(it) }

            audioManager.adjustStreamVolume(
                AudioManager.STREAM_MUSIC,
                AudioManager.ADJUST_MUTE,
                0,
            )
            toneGenerator?.startTone(ToneGenerator.TONE_PROP_BEEP, ANDROID_PROFANITY_MUTE_MS.toInt())

            profanityMuteRestoreRunnable = Runnable {
                audioManager.adjustStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    AudioManager.ADJUST_UNMUTE,
                    0,
                )
                profanityMuteRestoreRunnable = null
            }
            mainHandler.postDelayed(profanityMuteRestoreRunnable!!, ANDROID_PROFANITY_MUTE_MS)
        }
    }

    /**
     * ImageReader callback — 500 ms gate, JPEG encode, backend POST (BR-02).
     */
    private fun onFrameAvailable(reader: ImageReader) {
        if (profanityEnabled) {
            reader.acquireLatestImage()?.close()
            return
        }

        val now = SystemClock.elapsedRealtime()
        if (now - lastSampleElapsedMs < ScreenCaptureHelper.SAMPLE_INTERVAL_MS) {
            reader.acquireLatestImage()?.close()
            return
        }
        if (!isAnalyzing.compareAndSet(false, true)) {
            reader.acquireLatestImage()?.close()
            return
        }

        val image: Image? = reader.acquireLatestImage()
        if (image == null) {
            isAnalyzing.set(false)
            return
        }

        lastSampleElapsedMs = now
        var jpegBytes: ByteArray? = null
        try {
            jpegBytes = FrameEncoder.toJpeg(image, ScreenCaptureHelper.JPEG_QUALITY)
        } catch (e: Exception) {
            Log.e(TAG, "Frame encode error: ${e.message}")
        } finally {
            image.close()
        }

        if (jpegBytes == null || jpegBytes.isEmpty()) {
            isAnalyzing.set(false)
            return
        }

        val jpegCopy = jpegBytes
        networkExecutor?.execute {
            try {
                analyzeFrame(jpegCopy)
            } finally {
                isAnalyzing.set(false)
            }
        }
    }

    /**
     * Runs enabled category checks against FastAPI; updates overlay (fail-open).
     */
    private fun analyzeFrame(jpegBytes: ByteArray) {
        // #region agent log
        BackendApiClient.debugAgentLog(
            baseUrl = backendUrl,
            hypothesisId = "H1",
            location = "OverlayService.kt:analyzeFrame:entry",
            message = "overlay frame ready for analysis",
            data = mapOf(
                "jpegBytes" to jpegBytes.size,
                "categories" to visionCategories,
                "sensitivity" to sensitivity,
            ),
        )
        // #endregion
        var blurRequired = false
        var statusCategory = visionCategories.firstOrNull() ?: "nudity"

        for (category in visionCategories) {
            val response = BackendApiClient.analyzeImage(
                baseUrl = backendUrl,
                jpegBytes = jpegBytes,
                sensitivity = sensitivity,
                category = category,
            )

            if (response == null) {
                postOverlayChange(show = false)
                OverlayEventBridge.emitDetection(
                    detected = false,
                    category = category,
                    fromFallback = true,
                )
                OverlayEventBridge.emitServiceStatus(
                    OverlayEventBridge.STATUS_ERROR,
                    "Backend unreachable",
                )
                return
            }

            statusCategory = response.category
            // #region agent log
            BackendApiClient.debugAgentLog(
                baseUrl = backendUrl,
                hypothesisId = "H4",
                location = "OverlayService.kt:analyzeFrame:result",
                message = "overlay analyze-image result",
                data = mapOf(
                    "category" to response.category,
                    "action" to response.action,
                    "detected" to response.detected,
                    "shouldBlur" to response.shouldBlur,
                    "confidence" to response.confidence,
                ),
            )
            // #endregion
            if (response.shouldBlur) {
                blurRequired = true
                OverlayEventBridge.emitDetection(
                    detected = true,
                    category = response.category,
                    fromFallback = false,
                )
                break
            }
        }

        if (!blurRequired) {
            OverlayEventBridge.emitDetection(
                detected = false,
                category = statusCategory,
                fromFallback = false,
            )
        }
        postOverlayChange(show = blurRequired)
        // #region agent log
        BackendApiClient.debugAgentLog(
            baseUrl = backendUrl,
            hypothesisId = "H5",
            location = "OverlayService.kt:analyzeFrame:blurDecision",
            message = "overlay blur decision",
            data = mapOf(
                "blurRequired" to blurRequired,
                "categories" to visionCategories,
            ),
        )
        // #endregion
    }

    /**
     * Show or hide overlay — safe scenes release immediately (0ms, cross-platform parity).
     */
    private fun postOverlayChange(show: Boolean) {
        if (!show) {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                detachOverlayWindow()
            } else {
                mainHandler.post { detachOverlayWindow() }
            }
            return
        }

        if (Looper.myLooper() == Looper.getMainLooper()) {
            attachOverlayWindow()
        } else {
            mainHandler.post { attachOverlayWindow() }
        }
    }

    /**
     * Builds [WindowManager.LayoutParams] for a full-screen system overlay (BR-07).
     *
     * [FLAG_NOT_TOUCHABLE] and [FLAG_NOT_FOCUSABLE] keep the foreground app interactive.
     */
    private fun createOverlayLayoutParams(): WindowManager.LayoutParams {
        val overlayType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED

        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            overlayType,
            flags,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            title = "SafeViewOverlay"
        }
    }

    /**
     * Adds [OverlayView] via [WindowManager] when AI requests BLUR.
     */
    private fun attachOverlayWindow() {
        if (overlayView?.isAttachedToWindow == true) {
            overlayVisible.set(true)
            return
        }

        val wm = windowManager
        if (wm == null) {
            Log.e(TAG, "WindowManager unavailable — cannot show overlay")
            return
        }

        detachOverlayWindow()

        val view = OverlayView(applicationContext)
        val params = createOverlayLayoutParams()

        try {
            wm.addView(view, params)
            overlayView = view
            overlayVisible.set(true)
            OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_OVERLAY_SHOWN)
            Log.i(TAG, "Overlay window attached")
            // #region agent log
            BackendApiClient.debugAgentLog(
                baseUrl = backendUrl,
                hypothesisId = "H5",
                location = "OverlayService.kt:attachOverlayWindow",
                message = "overlay window attached",
                data = mapOf("attached" to true),
            )
            // #endregion
        } catch (e: SecurityException) {
            Log.e(TAG, "Overlay permission missing: ${e.message}")
            overlayView = null
            overlayVisible.set(false)
            // #region agent log
            BackendApiClient.debugAgentLog(
                baseUrl = backendUrl,
                hypothesisId = "H5",
                location = "OverlayService.kt:attachOverlayWindow",
                message = "overlay attach security exception",
                data = mapOf("error" to (e.message ?: "unknown")),
            )
            // #endregion
        } catch (e: Exception) {
            Log.e(TAG, "attachOverlayWindow failed: ${e.message}")
            overlayView = null
            overlayVisible.set(false)
            // #region agent log
            BackendApiClient.debugAgentLog(
                baseUrl = backendUrl,
                hypothesisId = "H5",
                location = "OverlayService.kt:attachOverlayWindow",
                message = "overlay attach failed",
                data = mapOf("error" to (e.message ?: "unknown")),
            )
            // #endregion
        }
    }

    /**
     * Removes the overlay from [WindowManager] when detection clears or service stops.
     */
    private fun detachOverlayWindow() {
        overlayVisible.set(false)
        val view = overlayView ?: return
        if (!view.isAttachedToWindow) {
            overlayView = null
            return
        }

        try {
            windowManager?.removeView(view)
            OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_OVERLAY_HIDDEN)
            Log.i(TAG, "Overlay window detached")
        } catch (e: Exception) {
            Log.e(TAG, "detachOverlayWindow: ${e.message}")
        } finally {
            overlayView = null
        }
    }

    private fun stopCapturePipeline() {
        audioCaptureHelper?.stop()
        captureHelper?.stop()
        captureThread?.quitSafely()
        captureThread = null
        captureHandler = null
        profanityMuteRestoreRunnable?.let { mainHandler.removeCallbacks(it) }
        profanityMuteRestoreRunnable = null
    }

    private fun shutdown() {
        detachOverlayWindow()
        stopCapturePipeline()
        toneGenerator?.release()
        toneGenerator = null
        networkExecutor?.shutdownNow()
        networkExecutor = null
        OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_STOPPED)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "SafeView Protection",
            NotificationManager.IMPORTANCE_LOW,
        )
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, OverlayService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this,
            STOP_ACTION_REQUEST_CODE,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("SafeView protection active")
            .setContentText("Screen monitoring is running")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(
                android.R.drawable.ic_media_pause,
                "Stop",
                stopPending,
            )
            .build()
    }
}
