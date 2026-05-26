// SafeView — AudioPlaybackCaptureHelper.kt
// Purpose: Capture device playback audio in 2s WAV chunks for profanity analysis (API 29+).

package com.safeview.safeview

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import androidx.annotation.RequiresApi

/**
 * Records mixed playback audio via [AudioPlaybackCaptureConfiguration] and emits WAV chunks.
 */
class AudioPlaybackCaptureHelper(
    private val context: Context,
) {
    companion object {
        private const val TAG = "SafeView"
        const val CHUNK_DURATION_MS = 2000L
        const val SAMPLE_RATE = 44100
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_STEREO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }

    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null
    private var audioRecord: AudioRecord? = null
    @Volatile
    private var running = false

    /**
     * Begin 2-second WAV chunk capture on a background thread.
     *
     * @param projection Active MediaProjection from screen capture consent.
     * @param onChunk Callback with WAV bytes ready for POST /analyze-audio.
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    fun start(
        projection: MediaProjection,
        onChunk: (ByteArray) -> Unit,
    ) {
        stop()

        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()

        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        if (minBuffer <= 0) {
            Log.e(TAG, "AudioRecord min buffer size invalid: $minBuffer")
            return
        }

        val bytesPerChunk = SAMPLE_RATE * 2 * 2 * (CHUNK_DURATION_MS / 1000).toInt()
        val bufferSize = maxOf(minBuffer * 4, bytesPerChunk)

        val record = AudioRecord.Builder()
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AUDIO_FORMAT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL_CONFIG)
                    .build(),
            )
            .setBufferSizeInBytes(bufferSize)
            .setAudioPlaybackCaptureConfig(config)
            .build()

        audioRecord = record
        captureThread = HandlerThread("SafeViewAudioCapture").apply { start() }
        captureHandler = Handler(captureThread!!.looper)
        running = true

        captureHandler?.post {
            try {
                record.startRecording()
                Log.i(TAG, "AudioPlaybackCapture started (chunkMs=$CHUNK_DURATION_MS)")
                val readBuffer = ByteArray(minBuffer)
                val pcmAccumulator = ByteArrayOutputList(bytesPerChunk + minBuffer)

                while (running) {
                    val read = record.read(readBuffer, 0, readBuffer.size)
                    if (read <= 0) {
                        continue
                    }
                    pcmAccumulator.write(readBuffer, read, read)
                    if (pcmAccumulator.size() >= bytesPerChunk) {
                        val pcm = pcmAccumulator.take(bytesPerChunk)
                        pcmAccumulator.discard(bytesPerChunk)
                        val wav = WavChunkBuilder.pcm16ToWav(pcm, SAMPLE_RATE, 2)
                        if (wav.isNotEmpty()) {
                            onChunk(wav)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "AudioPlaybackCapture loop error: ${e.message}")
            } finally {
                try {
                    record.stop()
                } catch (_: Exception) {
                }
                record.release()
            }
        }
    }

    /** Stop capture and release [AudioRecord]. */
    fun stop() {
        running = false
        captureThread?.quitSafely()
        captureThread = null
        captureHandler = null
        audioRecord = null
        Log.i(TAG, "AudioPlaybackCapture stopped")
    }

    /** Growable byte list for PCM accumulation without extra allocations per read. */
    private class ByteArrayOutputList(initialCapacity: Int) {
        private var buffer = ByteArray(initialCapacity)
        private var size = 0

        fun size(): Int = size

        fun write(source: ByteArray, offset: Int, length: Int) {
            ensureCapacity(size + length)
            System.arraycopy(source, offset, buffer, size, length)
            size += length
        }

        fun take(count: Int): ByteArray {
            val out = ByteArray(count)
            System.arraycopy(buffer, 0, out, 0, count)
            return out
        }

        fun discard(count: Int) {
            val remaining = size - count
            if (remaining > 0) {
                System.arraycopy(buffer, count, buffer, 0, remaining)
            }
            size = remaining
        }

        private fun ensureCapacity(required: Int) {
            if (required <= buffer.size) {
                return
            }
            var newSize = buffer.size
            while (newSize < required) {
                newSize *= 2
            }
            buffer = buffer.copyOf(newSize)
        }
    }
}
