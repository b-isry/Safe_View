# SafeView — audio_processor.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load OpenAI Whisper locally once at import and transcribe WebM audio bytes.

from __future__ import annotations

import io
import logging
import os
import tempfile
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

WHISPER_MODEL_NAME = "small"
# whisper-small supports both en (English) and am (Amharic) transcription languages.

_whisper_model: Optional[Any] = None
WHISPER_LOADED: bool = False


def load_whisper() -> None:
    """
    Load the Whisper small checkpoint once into the module-level cache.

    On success, sets _whisper_model and WHISPER_LOADED=True. On failure, logs,
    leaves _whisper_model=None, and sets WHISPER_LOADED=False (fail open).
    """
    global _whisper_model, WHISPER_LOADED

    try:
        import whisper

        _whisper_model = whisper.load_model(WHISPER_MODEL_NAME)
        WHISPER_LOADED = True
        logger.info(
            "[SafeView] Loaded whisper-%s model.",
            WHISPER_MODEL_NAME,
        )
    except Exception as exc:
        logger.error(
            "[SafeView] Failed to load whisper-%s: %s. Audio transcription will fail open.",
            WHISPER_MODEL_NAME,
            exc,
        )
        _whisper_model = None
        WHISPER_LOADED = False


def is_silent(audio_bytes: bytes) -> bool:
    """
    Skip tiny or near-zero-energy chunks before decode/transcribe.

    Args:
        audio_bytes: Raw WebM fragment from the browser.

    Returns:
        bool: True when the chunk should not be sent to Whisper.
    """
    if len(audio_bytes) < 1000:
        return True

    sample_len = min(len(audio_bytes), 4096)
    mean_square = sum(b * b for b in audio_bytes[:sample_len]) / sample_len
    rms_value = mean_square**0.5 / 255.0
    return rms_value < 0.01


def webm_to_wav_bytes(audio_bytes: bytes) -> bytes | None:
    """
    Extract PCM audio from standalone WebM/Opus bytes using pydub.

    Args:
        audio_bytes: Raw WebM chunk from MediaRecorder stop/restart loop.

    Returns:
        bytes | None: WAV file bytes, or None when conversion fails.
    """
    try:
        from pydub import AudioSegment

        audio = AudioSegment.from_file(io.BytesIO(audio_bytes), format="webm")
        wav_buffer = io.BytesIO()
        audio.export(wav_buffer, format="wav")
        return wav_buffer.getvalue()
    except Exception as exc:
        logger.error("[SafeView] Pydub Error: %s", str(exc))
        return None


def transcribe_audio(audio_bytes: bytes, language: str) -> str:
    """
    Transcribe audio bytes using Whisper. Converts WebM to WAV first when possible.

    Args:
        audio_bytes: Raw WebM audio from the client.
        language: Whisper language code (e.g. en, am).

    Returns:
        str: Transcribed text, or empty string on error or if Whisper is not loaded.
    """
    logger.info(
        "[SafeView][Audio-B1] Processing standalone file: %s bytes",
        len(audio_bytes),
    )
    logger.info(
        "[SafeView][Audio-B1] Received audio chunk, size=%s bytes, language=%s",
        len(audio_bytes),
        language,
    )

    if not WHISPER_LOADED or _whisper_model is None:
        logger.error(
            "[SafeView] transcribe_audio called but whisper-%s is not loaded.",
            WHISPER_MODEL_NAME,
        )
        return ""

    if is_silent(audio_bytes):
        logger.debug("[SafeView][Audio-B2] Silent chunk skipped")
        return ""

    wav_bytes = webm_to_wav_bytes(audio_bytes)
    if not wav_bytes:
        logger.warning(
            "[SafeView][Audio-B2] WebM to WAV conversion failed — chunk skipped (size=%s)",
            len(audio_bytes),
        )
        return ""

    tmp_path: Optional[str] = None
    transcribe_started = time.perf_counter()
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(wav_bytes)
            tmp_path = tmp.name

        result = _whisper_model.transcribe(
            tmp_path,
            language=language,
            beam_size=1,
            best_of=1,
            temperature=0,
            fp16=False,
            condition_on_previous_text=False,
        )
        text = result.get("text", "").strip().lower()
        elapsed_ms = (time.perf_counter() - transcribe_started) * 1000
        logger.info(
            "[SafeView][Audio-B3] Transcription: '%s' (processed in %.0fms)",
            text[:100],
            elapsed_ms,
        )
        return text
    except Exception as exc:
        logger.error(
            "[SafeView] transcribe_audio failed (language=%s): %s",
            language,
            exc,
        )
        return ""
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


load_whisper()
