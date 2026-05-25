// SafeView — BackendApiClient.kt
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: POST screen frames to FastAPI /analyze-image (fail-open on error).

package com.safeview.safeview

import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

data class AnalyzeResponse(
    val category: String,
    val detected: Boolean,
    val confidence: Float,
    val action: String,
    val modelLoaded: Boolean,
) {
    /** True when backend requests full-screen overlay. */
    val shouldBlur: Boolean
        get() = action.equals("BLUR", ignoreCase = true) || detected
}

/**
 * HTTP client for the local SafeView FastAPI backend only.
 */
object BackendApiClient {

    private const val TAG = "SafeView"
    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val READ_TIMEOUT_MS = 8_000
    private const val CONFIDENCE_FLOOR = 0.75f

    /**
     * Relay debug logs to FastAPI /internal/debug-ingest (fire-and-forget).
     */
    fun debugAgentLog(
        baseUrl: String,
        hypothesisId: String,
        location: String,
        message: String,
        data: Map<String, Any?> = emptyMap(),
    ) {
        // #region agent log
        val normalizedBase = baseUrl.trimEnd('/')
        if (normalizedBase.isEmpty()) return

        var connection: HttpURLConnection? = null
        try {
            val payload = JSONObject().apply {
                put("hypothesisId", hypothesisId)
                put("location", location)
                put("message", message)
                put("data", JSONObject(data))
            }
            connection = (URL("$normalizedBase/internal/debug-ingest").openConnection()
                as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 2_000
                readTimeout = 2_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(payload.toString().toByteArray()) }
            }
            connection.responseCode
        } catch (e: Exception) {
            Log.d(TAG, "debug ingest failed: ${e.message}")
        } finally {
            connection?.disconnect()
        }
        // #endregion
    }

    /**
     * POST multipart JPEG to /analyze-image. Fail-open: null on any error.
     */
    fun analyzeImage(
        baseUrl: String,
        jpegBytes: ByteArray,
        sensitivity: Float,
        category: String,
    ): AnalyzeResponse? {
        if (jpegBytes.isEmpty()) return null

        val normalizedBase = baseUrl.trimEnd('/')
        val boundary = "----SafeView${UUID.randomUUID()}"
        val url = URL("$normalizedBase/analyze-image")

        var connection: HttpURLConnection? = null
        return try {
            connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.doOutput = true
            connection.setRequestProperty(
                "Content-Type",
                "multipart/form-data; boundary=$boundary",
            )

            val body = buildMultipartBody(
                boundary = boundary,
                jpegBytes = jpegBytes,
                sensitivity = sensitivity.coerceIn(0f, 1f),
                category = category,
            )
            connection.outputStream.use { it.write(body) }

            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "analyze-image HTTP $code")
                return null
            }

            val responseText = connection.inputStream.bufferedReader().use { it.readText() }
            parseResponse(responseText, category)
        } catch (e: Exception) {
            Log.e(TAG, "Backend analyze failed: ${e.message}")
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun buildMultipartBody(
        boundary: String,
        jpegBytes: ByteArray,
        sensitivity: Float,
        category: String,
    ): ByteArray {
        val crlf = "\r\n"
        val out = ByteArrayOutputStream()

        fun writeField(name: String, value: String) {
            out.write("--$boundary$crlf".toByteArray())
            out.write("Content-Disposition: form-data; name=\"$name\"$crlf$crlf".toByteArray())
            out.write(value.toByteArray())
            out.write(crlf.toByteArray())
        }

        writeField("sensitivity", sensitivity.toString())
        writeField("category", category)

        out.write("--$boundary$crlf".toByteArray())
        out.write(
            "Content-Disposition: form-data; name=\"frame\"; filename=\"frame.jpg\"$crlf"
                .toByteArray(),
        )
        out.write("Content-Type: image/jpeg$crlf$crlf".toByteArray())
        out.write(jpegBytes)
        out.write(crlf.toByteArray())

        out.write("--$boundary--$crlf".toByteArray())
        return out.toByteArray()
    }

    private fun parseResponse(jsonText: String, fallbackCategory: String): AnalyzeResponse? {
        return try {
            val json = JSONObject(jsonText)
            val confidence = json.optDouble("confidence", 0.0).toFloat()
            val detected = json.optBoolean("detected", false)
            val action = json.optString("action", "ALLOW")
            AnalyzeResponse(
                category = json.optString("category", fallbackCategory),
                detected = detected,
                confidence = confidence,
                action = action,
                modelLoaded = json.optBoolean("model_loaded", true),
            )
        } catch (e: Exception) {
            Log.e(TAG, "Invalid analyze JSON: ${e.message}")
            null
        }
    }

    /**
     * BR-01 client-side check when interpreting confidence (backend also applies floor).
     */
    fun meetsThreshold(confidence: Float, userSensitivity: Float): Boolean {
        val effective = maxOf(CONFIDENCE_FLOOR, userSensitivity)
        return confidence >= effective
    }
}
