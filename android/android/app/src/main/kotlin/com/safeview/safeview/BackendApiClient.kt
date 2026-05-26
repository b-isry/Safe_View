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

/** JSON body from POST /analyze-audio. */
data class AnalyzeAudioResponse(
    val detected: Boolean,
    val action: String,
    val durationMs: Int,
    val whisperLoaded: Boolean,
) {
    val shouldMute: Boolean
        get() = action.equals("MUTE", ignoreCase = true) || detected
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
     * POST multipart WAV/WebM to /analyze-audio. Fail-open: null on any error.
     */
    fun analyzeAudio(
        baseUrl: String,
        audioBytes: ByteArray,
        language: String,
        sensitivity: Float,
        profanityWords: List<String>,
        audioFormat: String = "wav",
    ): AnalyzeAudioResponse? {
        if (audioBytes.isEmpty()) return null

        val normalizedBase = baseUrl.trimEnd('/')
        val boundary = "----SafeView${UUID.randomUUID()}"
        val url = URL("$normalizedBase/analyze-audio")
        val wordsJson = org.json.JSONArray(profanityWords).toString()

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

            val body = buildAudioMultipartBody(
                boundary = boundary,
                audioBytes = audioBytes,
                language = language,
                sensitivity = sensitivity.coerceIn(0f, 1f),
                profanityWordsJson = wordsJson,
                audioFormat = audioFormat,
            )
            connection.outputStream.use { it.write(body) }

            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "analyze-audio HTTP $code")
                return null
            }

            val responseText = connection.inputStream.bufferedReader().use { it.readText() }
            parseAudioResponse(responseText)
        } catch (e: Exception) {
            Log.e(TAG, "Backend analyze-audio failed: ${e.message}")
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun buildAudioMultipartBody(
        boundary: String,
        audioBytes: ByteArray,
        language: String,
        sensitivity: Float,
        profanityWordsJson: String,
        audioFormat: String,
    ): ByteArray {
        val crlf = "\r\n"
        val out = ByteArrayOutputStream()
        val filename = if (audioFormat == "wav") "chunk.wav" else "chunk.webm"
        val mime = if (audioFormat == "wav") "audio/wav" else "audio/webm"

        fun writeField(name: String, value: String) {
            out.write("--$boundary$crlf".toByteArray())
            out.write("Content-Disposition: form-data; name=\"$name\"$crlf$crlf".toByteArray())
            out.write(value.toByteArray())
            out.write(crlf.toByteArray())
        }

        writeField("language", language)
        writeField("sensitivity", sensitivity.toString())
        writeField("profanity_words", profanityWordsJson)
        writeField("audio_format", audioFormat)

        out.write("--$boundary$crlf".toByteArray())
        out.write(
            "Content-Disposition: form-data; name=\"audio_chunk\"; filename=\"$filename\"$crlf"
                .toByteArray(),
        )
        out.write("Content-Type: $mime$crlf$crlf".toByteArray())
        out.write(audioBytes)
        out.write(crlf.toByteArray())
        out.write("--$boundary--$crlf".toByteArray())
        return out.toByteArray()
    }

    private fun parseAudioResponse(jsonText: String): AnalyzeAudioResponse? {
        return try {
            val json = JSONObject(jsonText)
            AnalyzeAudioResponse(
                detected = json.optBoolean("detected", false),
                action = json.optString("action", "ALLOW"),
                durationMs = json.optInt("duration_ms", 0),
                whisperLoaded = json.optBoolean("whisper_loaded", false),
            )
        } catch (e: Exception) {
            Log.e(TAG, "Invalid analyze-audio JSON: ${e.message}")
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
