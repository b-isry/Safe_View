// SafeView — OverlayEventBridge.kt
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Emit detection and service status events to Flutter EventChannel.

package com.safeview.safeview

import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.EventChannel

/**
 * Posts overlay events to [MainActivity.statusEventSink] on the main thread.
 */
object OverlayEventBridge {

    private const val TAG = "SafeView"

    const val KEY_EVENT_TYPE = "eventType"
    const val KEY_DETECTED = "detected"
    const val KEY_CATEGORY = "category"
    const val KEY_TIMESTAMP = "timestamp"
    const val KEY_FROM_FALLBACK = "fromFallback"
    const val KEY_STATUS = "status"
    const val KEY_MESSAGE = "message"

    const val EVENT_DETECTION = "detection"
    const val EVENT_SERVICE = "service"

    const val STATUS_STARTED = "started"
    const val STATUS_CAPTURING = "capturing"
    const val STATUS_STOPPED = "stopped"
    const val STATUS_ERROR = "error"
    const val STATUS_OVERLAY_SHOWN = "overlay_shown"
    const val STATUS_OVERLAY_HIDDEN = "overlay_hidden"

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * AI detection result for the status feed (category + timestamp only).
     */
    fun emitDetection(
        detected: Boolean,
        category: String,
        fromFallback: Boolean = false,
    ) {
        emit(
            mapOf(
                KEY_EVENT_TYPE to EVENT_DETECTION,
                KEY_DETECTED to detected,
                KEY_CATEGORY to category,
                KEY_TIMESTAMP to System.currentTimeMillis(),
                KEY_FROM_FALLBACK to fromFallback,
            ),
        )
    }

    /**
     * Service lifecycle / overlay visibility update.
     */
    fun emitServiceStatus(
        status: String,
        message: String? = null,
    ) {
        val payload = mutableMapOf<String, Any>(
            KEY_EVENT_TYPE to EVENT_SERVICE,
            KEY_STATUS to status,
            KEY_TIMESTAMP to System.currentTimeMillis(),
        )
        if (message != null) {
            payload[KEY_MESSAGE] = message
        }
        emit(payload)
    }

    private fun emit(payload: Map<String, Any>) {
        val sink: EventChannel.EventSink = MainActivity.statusEventSink ?: return
        mainHandler.post {
            try {
                sink.success(payload)
            } catch (e: Exception) {
                Log.e(TAG, "EventChannel emit failed: ${e.message}")
            }
        }
    }
}
