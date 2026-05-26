// SafeView — WavChunkBuilder.kt
// Purpose: Wrap PCM16LE samples in a RIFF WAV container for /analyze-audio.

package com.safeview.safeview

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Builds WAV byte arrays from raw PCM captured via AudioPlaybackCapture.
 */
object WavChunkBuilder {

    /**
     * @param pcmBytes Interleaved PCM 16-bit little-endian samples.
     * @param sampleRate Sample rate in Hz (e.g. 44100).
     * @param channelCount Number of channels (1 or 2).
     */
    fun pcm16ToWav(
        pcmBytes: ByteArray,
        sampleRate: Int,
        channelCount: Int,
    ): ByteArray {
        val bitsPerSample = 16
        val byteRate = sampleRate * channelCount * bitsPerSample / 8
        val blockAlign = (channelCount * bitsPerSample / 8).toShort()
        val dataSize = pcmBytes.size
        val chunkSize = 36 + dataSize

        val out = ByteArrayOutputStream(44 + dataSize)
        out.write("RIFF".toByteArray())
        out.write(intLe(chunkSize))
        out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray())
        out.write(intLe(16))
        out.write(shortLe(1))
        out.write(shortLe(channelCount.toShort()))
        out.write(intLe(sampleRate))
        out.write(intLe(byteRate))
        out.write(shortLe(blockAlign))
        out.write(shortLe(bitsPerSample.toShort()))
        out.write("data".toByteArray())
        out.write(intLe(dataSize))
        out.write(pcmBytes)
        return out.toByteArray()
    }

    private fun intLe(value: Int): ByteArray =
        ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()

    private fun shortLe(value: Short): ByteArray =
        ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(value).array()
}
