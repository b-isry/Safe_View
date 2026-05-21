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
import android.media.Image
import android.media.ImageReader
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
        const val ACTION_STOP = "com.safeview.safeview.STOP_PROTECTION"

        /** Categories with real models (stubs skipped per frame). */
        private val ACTIVE_MODEL_CATEGORIES = listOf("nudity")
    }

    private var windowManager: WindowManager? = null
    private var overlayView: OverlayView? = null
    private var captureHelper: ScreenCaptureHelper? = null

    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var networkExecutor: ExecutorService? = null

    private var sensitivity: Float = 0.75f
    private var backendUrl: String = "http://10.0.2.2:8000"
    private var categories: List<String> = listOf("nudity")

    private var lastSampleElapsedMs: Long = 0L
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
        networkExecutor = Executors.newSingleThreadExecutor()
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
        categories = intent?.getStringArrayListExtra(EXTRA_CATEGORIES)
            ?.filter { ACTIVE_MODEL_CATEGORIES.contains(it) }
            ?.ifEmpty { ACTIVE_MODEL_CATEGORIES }
            ?: ACTIVE_MODEL_CATEGORIES

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

        captureHelper?.start(
            resultCode = resultCode,
            data = projectionData,
            handler = captureHandler!!,
            onImageAvailable = imageAvailableListener,
        )
        lastSampleElapsedMs = 0L
        OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_CAPTURING)
        Log.i(TAG, "Capture pipeline started url=$backendUrl categories=$categories")
    }

    /**
     * ImageReader callback — 500 ms gate, JPEG encode, backend POST (BR-02).
     */
    private fun onFrameAvailable(reader: ImageReader) {
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
        var blurRequired = false
        var statusCategory = categories.firstOrNull() ?: "nudity"

        for (category in categories) {
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
    }

    private fun postOverlayChange(show: Boolean) {
        mainHandler.post {
            if (show) attachOverlayWindow() else detachOverlayWindow()
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
        } catch (e: SecurityException) {
            Log.e(TAG, "Overlay permission missing: ${e.message}")
            overlayView = null
            overlayVisible.set(false)
        } catch (e: Exception) {
            Log.e(TAG, "attachOverlayWindow failed: ${e.message}")
            overlayView = null
            overlayVisible.set(false)
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
        captureHelper?.stop()
        captureThread?.quitSafely()
        captureThread = null
        captureHandler = null
    }

    private fun shutdown() {
        detachOverlayWindow()
        stopCapturePipeline()
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
