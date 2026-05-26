// SafeView — MainActivity.kt
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Flutter entry activity; registers overlay MethodChannel and EventChannel.

package com.safeview.safeview

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Hosts Flutter UI and bridges [OverlayService] via [METHOD_CHANNEL] / [EVENT_CHANNEL].
 */
class MainActivity : FlutterFragmentActivity() {

    companion object {
        private const val TAG = "SafeView"
        const val METHOD_CHANNEL = "com.safeview/overlay"
        const val EVENT_CHANNEL = "com.safeview/status"
        /** Request code for MediaProjection consent (legacy [onActivityResult] path). */
        private const val MEDIA_PROJECTION_REQUEST_CODE = 9001

        private const val STATE_CAPTURE_SENSITIVITY = "state_capture_sensitivity"
        private const val STATE_CAPTURE_CATEGORIES = "state_capture_categories"
        private const val STATE_CAPTURE_BACKEND_URL = "state_capture_backend_url"
        private const val STATE_AWAITING_PROJECTION = "state_awaiting_projection"

        /** Event sink set when Flutter listens on [EVENT_CHANNEL]. */
        @JvmStatic
        var statusEventSink: EventChannel.EventSink? = null
    }

    private var methodChannel: MethodChannel? = null
    private var pendingStartResult: MethodChannel.Result? = null

    /** Stored from [requestMediaProjectionAndStart] until consent returns. */
    private var captureSensitivity: Float = 0.75f
    private var captureCategories: ArrayList<String> = arrayListOf("nudity")
    private var captureBackendUrl: String = "http://10.0.2.2:8000"
    private var awaitingMediaProjectionConsent: Boolean = false

    private var mediaProjectionLauncher: ActivityResultLauncher<Intent>? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        registerOverlayMethodChannel(flutterEngine)
        registerOverlayEventChannel(flutterEngine)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (mediaProjectionLauncher == null) {
            registerMediaProjectionLauncher()
        }
        if (savedInstanceState != null) {
            restoreCaptureState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_AWAITING_PROJECTION, awaitingMediaProjectionConsent)
        if (awaitingMediaProjectionConsent) {
            outState.putFloat(STATE_CAPTURE_SENSITIVITY, captureSensitivity)
            outState.putStringArrayList(STATE_CAPTURE_CATEGORIES, captureCategories)
            outState.putString(STATE_CAPTURE_BACKEND_URL, captureBackendUrl)
        }
    }

    private fun restoreCaptureState(savedInstanceState: Bundle) {
        awaitingMediaProjectionConsent =
            savedInstanceState.getBoolean(STATE_AWAITING_PROJECTION, false)
        if (!awaitingMediaProjectionConsent) return
        captureSensitivity = savedInstanceState.getFloat(STATE_CAPTURE_SENSITIVITY, 0.75f)
        captureCategories = savedInstanceState.getStringArrayList(STATE_CAPTURE_CATEGORIES)
            ?: arrayListOf("nudity")
        captureBackendUrl = savedInstanceState.getString(STATE_CAPTURE_BACKEND_URL)
            ?: "http://10.0.2.2:8000"
    }

    /**
     * Modern consent callback — Flutter embedding often does not deliver [onActivityResult].
     */
    private fun registerMediaProjectionLauncher() {
        mediaProjectionLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult(),
        ) { result ->
            handleMediaProjectionConsent(result.resultCode, result.data)
        }
    }

    /**
     * MethodChannel `com.safeview/overlay` — startCapture, stopCapture, permissions.
     */
    private fun registerOverlayMethodChannel(flutterEngine: FlutterEngine) {
        methodChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            METHOD_CHANNEL,
        ).apply {
            setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "startCapture" -> requestMediaProjectionAndStart(call, result)
                        "stopCapture" -> stopOverlayCapture(result)
                        "canDrawOverlays" -> {
                            result.success(Settings.canDrawOverlays(this@MainActivity))
                        }
                        "openOverlaySettings" -> {
                            openOverlayPermissionSettings()
                            result.success(null)
                        }
                        "getPermissionStatus" -> {
                            result.success(readPermissionStatus())
                        }
                        "openAppSettings" -> {
                            openApplicationSettings()
                            result.success(null)
                        }
                        "openNotificationSettings" -> {
                            openNotificationSettings()
                            result.success(null)
                        }
                        else -> result.notImplemented()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "MethodChannel error: ${e.message}")
                    result.error("SAFEVIEW_ERROR", e.message, null)
                }
            }
        }
    }

    /**
     * EventChannel `com.safeview/status` — detection + service status stream.
     */
    private fun registerOverlayEventChannel(flutterEngine: FlutterEngine) {
        EventChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            EVENT_CHANNEL,
        ).setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                statusEventSink = events
                Log.i(TAG, "EventChannel listener attached")
                OverlayEventBridge.emitServiceStatus(
                    OverlayEventBridge.STATUS_STARTED,
                    "Event stream connected",
                )
            }

            override fun onCancel(arguments: Any?) {
                statusEventSink = null
                Log.i(TAG, "EventChannel listener detached")
            }
        })
    }

    /**
     * Stops [OverlayService] and acknowledges Flutter [stopCapture].
     */
    private fun stopOverlayCapture(result: MethodChannel.Result) {
        try {
            val stopIntent = Intent(this, OverlayService::class.java).apply {
                action = OverlayService.ACTION_STOP
            }
            startService(stopIntent)
            stopService(Intent(this, OverlayService::class.java))
            OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_STOPPED)
            result.success(null)
        } catch (e: Exception) {
            Log.e(TAG, "stopCapture failed: ${e.message}")
            result.error("SAFEVIEW_ERROR", e.message, null)
        }
    }

    private fun readPermissionStatus(): Map<String, Boolean> {
        val overlayGranted = Settings.canDrawOverlays(this)
        val notificationsGranted =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(
                    this,
                    android.Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
            } else {
                true
            }
        return mapOf(
            "overlay" to overlayGranted,
            "notifications" to notificationsGranted,
            "internet" to true,
        )
    }

    private fun openOverlayPermissionSettings() {
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:$packageName"),
        )
        startActivity(intent)
    }

    private fun openApplicationSettings() {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:$packageName"),
        )
        startActivity(intent)
    }

    private fun openNotificationSettings() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            }
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            }
        }
        startActivity(intent)
    }

    /**
     * Launches system MediaProjection consent, then starts [OverlayService].
     */
    private fun requestMediaProjectionAndStart(
        call: io.flutter.plugin.common.MethodCall,
        result: MethodChannel.Result,
    ) {
        if (pendingStartResult != null) {
            result.error("SAFEVIEW_BUSY", "Capture start already in progress", null)
            return
        }

        if (!Settings.canDrawOverlays(this)) {
            OverlayEventBridge.emitServiceStatus(
                OverlayEventBridge.STATUS_ERROR,
                "Display over other apps permission required",
            )
            result.error(
                "SAFEVIEW_NO_OVERLAY_PERMISSION",
                "Display over other apps permission required",
                null,
            )
            return
        }

        captureSensitivity = (call.argument<Double>("sensitivity") ?: 0.75).toFloat()
        @Suppress("UNCHECKED_CAST")
        val categories =
            call.argument<List<String>>("categories") ?: listOf("nudity")
        captureCategories = ArrayList(categories)
        captureBackendUrl = call.argument<String>("backendUrl") ?: "http://10.0.2.2:8000"

        pendingStartResult = result
        awaitingMediaProjectionConsent = true

        val projectionManager =
            getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val consentIntent = projectionManager.createScreenCaptureIntent()

        val launcher = mediaProjectionLauncher
        if (launcher != null) {
            launcher.launch(consentIntent)
            return
        }

        @Suppress("DEPRECATION")
        startActivityForResult(consentIntent, MEDIA_PROJECTION_REQUEST_CODE)
    }

    /**
     * Legacy [onActivityResult] path when [ActivityResultLauncher] is unavailable.
     * Consent [resultCode] and [data] must be forwarded to [OverlayService] unchanged.
     */
    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == MEDIA_PROJECTION_REQUEST_CODE) {
            handleMediaProjectionConsent(resultCode, data)
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    /**
     * Runs after the user responds to the MediaProjection dialog.
     * Starts [OverlayService] only here — never from [requestMediaProjectionAndStart].
     */
    private fun handleMediaProjectionConsent(resultCode: Int, data: Intent?) {
        if (!awaitingMediaProjectionConsent) return

        val pendingResult = pendingStartResult
        pendingStartResult = null
        awaitingMediaProjectionConsent = false

        if (pendingResult == null) {
            Log.w(TAG, "MediaProjection consent received with no pending MethodChannel result")
            return
        }

        if (resultCode != Activity.RESULT_OK || data == null) {
            OverlayEventBridge.emitServiceStatus(
                OverlayEventBridge.STATUS_ERROR,
                "Screen capture permission denied",
            )
            pendingResult.success(false)
            return
        }

        try {
            startOverlayServiceWithProjection(
                resultCode = resultCode,
                projectionData = data,
                sensitivity = captureSensitivity,
                categories = captureCategories,
                backendUrl = captureBackendUrl,
            )
            OverlayEventBridge.emitServiceStatus(OverlayEventBridge.STATUS_CAPTURING)
            pendingResult.success(true)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start OverlayService: ${e.message}")
            OverlayEventBridge.emitServiceStatus(
                OverlayEventBridge.STATUS_ERROR,
                e.message,
            )
            pendingResult.error("SAFEVIEW_ERROR", e.message, null)
        }
    }

    /**
     * Starts [OverlayService] with capture settings and MediaProjection consent tokens.
     *
     * [resultCode] and [projectionData] are the values from the system consent activity;
     * they map to [OverlayService.EXTRA_PROJECTION_RESULT_CODE] and
     * [OverlayService.EXTRA_PROJECTION_DATA].
     */
    private fun startOverlayServiceWithProjection(
        resultCode: Int,
        projectionData: Intent,
        sensitivity: Float,
        categories: ArrayList<String>,
        backendUrl: String,
    ) {
        val consentData = Intent(projectionData)
        val intent = Intent(this, OverlayService::class.java).apply {
            putExtra(OverlayService.EXTRA_SENSITIVITY, sensitivity)
            putStringArrayListExtra(OverlayService.EXTRA_CATEGORIES, categories)
            putExtra(OverlayService.EXTRA_BACKEND_URL, backendUrl)
            putExtra(OverlayService.EXTRA_PROJECTION_RESULT_CODE, resultCode)
            putExtra(OverlayService.EXTRA_PROJECTION_DATA, consentData)
        }
        Log.i(
            TAG,
            "Starting OverlayService resultCode=$resultCode backend=$backendUrl categories=$categories",
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }
}
