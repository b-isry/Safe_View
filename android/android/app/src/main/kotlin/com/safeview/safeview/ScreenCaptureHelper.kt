// SafeView — ScreenCaptureHelper.kt
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: MediaProjection, VirtualDisplay, and ImageReader frame capture setup.

package com.safeview.safeview

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager

/**
 * Configures MediaProjection → VirtualDisplay → ImageReader capture pipeline.
 */
class ScreenCaptureHelper(
    private val context: Context,
) {
    companion object {
        private const val TAG = "SafeView"
        const val SAMPLE_INTERVAL_MS = 500L
        const val JPEG_QUALITY = 70
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null

    /**
     * Returns the system [MediaProjectionManager].
     */
    fun projectionManager(): MediaProjectionManager =
        context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager

    /**
     * Starts capture from consent [resultCode] and [data] Intent.
     *
     * @param handler Handler for [ImageReader.OnImageAvailableListener] (background thread).
     */
    fun start(
        resultCode: Int,
        data: Intent,
        handler: Handler,
        onImageAvailable: ImageReader.OnImageAvailableListener,
    ) {
        stop()

        val projection = projectionManager().getMediaProjection(resultCode, data)
            ?: throw IllegalStateException("MediaProjection consent invalid")
        mediaProjection = projection
        projection.registerCallback(
            object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.i(TAG, "MediaProjection stopped by system")
                    stop()
                }
            },
            handler,
        )

        val metrics = DisplayMetrics()
        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getRealMetrics(metrics)

        val width = metrics.widthPixels
        val height = metrics.heightPixels
        val density = metrics.densityDpi

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader?.setOnImageAvailableListener(onImageAvailable, handler)

        virtualDisplay = projection.createVirtualDisplay(
            "SafeViewCapture",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface,
            null,
            handler,
        )
        Log.i(TAG, "Screen capture started ${width}x$height")
    }

    /**
     * Releases MediaProjection, VirtualDisplay, and ImageReader (BR-02).
     */
    fun stop() {
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        mediaProjection?.stop()
        mediaProjection = null
        Log.i(TAG, "Screen capture stopped")
    }
}
