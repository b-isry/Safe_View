// SafeView — FrameEncoder.kt
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Convert ImageReader frames to JPEG bytes (caller must close Image after use).

package com.safeview.safeview

import android.graphics.Bitmap
import android.media.Image
import android.util.Log
import java.io.ByteArrayOutputStream

/**
 * Encodes [Image] planes to JPEG without retaining pixel data on disk.
 */
object FrameEncoder {

    private const val TAG = "SafeView"

    /**
     * Reads [image] pixels into a bitmap and compresses to JPEG.
     *
     * Does not close [image] — caller must call [Image.close] in a finally block (BR-02).
     *
     * @param image Open [Image] from [ImageReader.acquireLatestImage].
     * @param quality JPEG quality 0–100.
     * @return JPEG bytes or null on failure.
     */
    fun toJpeg(image: Image, quality: Int = ScreenCaptureHelper.JPEG_QUALITY): ByteArray? {
        var bitmap: Bitmap? = null
        return try {
            bitmap = imageToBitmap(image)
            if (bitmap == null) return null
            val stream = ByteArrayOutputStream()
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)) {
                Log.w(TAG, "JPEG compress returned false")
                return null
            }
            stream.toByteArray()
        } catch (e: Exception) {
            Log.e(TAG, "FrameEncoder.toJpeg failed: ${e.message}")
            null
        } finally {
            bitmap?.recycle()
        }
    }

    private fun imageToBitmap(image: Image): Bitmap? {
        val plane = image.planes[0]
        val buffer = plane.buffer
        buffer.rewind()
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val width = image.width
        val height = image.height
        val rowPadding = rowStride - pixelStride * width

        val bitmap = Bitmap.createBitmap(
            width + rowPadding / pixelStride,
            height,
            Bitmap.Config.ARGB_8888,
        )
        bitmap.copyPixelsFromBuffer(buffer)
        return if (rowPadding == 0) {
            bitmap
        } else {
            Bitmap.createBitmap(bitmap, 0, 0, width, height).also { cropped ->
                bitmap.recycle()
            }
        }
    }
}
