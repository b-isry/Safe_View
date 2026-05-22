# SafeView — audio_processor.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load OpenAI Whisper locally once at import and transcribe WebM audio bytes.

from __future__ import annotations

import logging
import os
import tempfile
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


def transcribe_audio(audio_bytes: bytes, language: str) -> str:
    """
    Transcribe WebM audio bytes with the cached Whisper model.

    Writes input to a temporary .webm file, runs transcribe(), and returns
    lowercased stripped text. Temp file is removed in a finally block (BR-02).

    Args:
        audio_bytes: Raw WebM audio from the client.
        language: Whisper language code (e.g. en, am).

    Returns:
        str: Transcribed text, or empty string on error or if Whisper is not loaded.
    """
    if not WHISPER_LOADED or _whisper_model is None:
        logger.error(
            "[SafeView] transcribe_audio called but whisper-%s is not loaded.",
            WHISPER_MODEL_NAME,
        )
        return ""

    temp_path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(
            suffix=".webm", delete=False
        ) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = temp_file.name

        result = _whisper_model.transcribe(
            temp_path,
            language=language,
            fp16=False,
        )
        text = result.get("text", "") if isinstance(result, dict) else ""
        return str(text).lower().strip()
    except Exception as exc:
        logger.error(
            "[SafeView] transcribe_audio failed (language=%s): %s",
            language,
            exc,
        )
        return ""
    finally:
        if temp_path is not None:
            try:
                os.unlink(temp_path)
            except OSError as exc:
                logger.warning(
                    "[SafeView] Failed to delete temp audio file %s: %s",
                    temp_path,
                    exc,
                )


load_whisper()
