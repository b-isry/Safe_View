# SafeView — models/profanity.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Profanity detection via Whisper transcription and blacklist matching.
#
# Interface contract (image /analyze-image):
#   Input:  PIL Image, sensitivity: float (0.0–1.0)
#   Output: { "category": str, "detected": bool, "confidence": float, "action": "BLUR"|"ALLOW" }
#
# Audio pipeline (POST /analyze-audio): analyze_audio(bytes, language, sensitivity)

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from PIL import Image

import audio_processor
import profanity_service

logger = logging.getLogger(__name__)

CATEGORY = "profanity"
ACTION_ALLOW = "ALLOW"
ACTION_MUTE = "MUTE"
ACTION_BEEP = "BEEP"
AUDIO_ACTION_BEEP = "BEEP"
# BR-05: reactive mute duration when profanity is detected (0ms vault)
MUTE_DURATION_MS = 1500


def analyze_audio(
    audio_bytes: bytes,
    language: str,
    sensitivity: float,
    extra_words: Optional[List[str]] = None,
    audio_format: str = "webm",
) -> Dict[str, Any]:
    """
    Transcribe WebM audio and run blacklist profanity detection.

    Args:
        audio_bytes: WebM/Opus or WAV chunk from the client.
        language: Whisper language code — "en" or "am".
        sensitivity: Unused for profanity; kept for API consistency.
        extra_words: Optional user profanity list from extension settings.
        audio_format: Container hint for pydub — "webm" or "wav".

    Returns:
        dict: detected, action (MUTE | ALLOW), duration_ms, whisper_loaded.
    """
    _ = sensitivity

    base_response: Dict[str, Any] = {
        "category": CATEGORY,
        "detected": False,
        "action": ACTION_ALLOW,
        "audio_action": ACTION_ALLOW,
        "duration_ms": 0,
        "whisper_loaded": audio_processor.WHISPER_LOADED,
        "confidence": 0.0,
        "transcribed_text": "",
    }

    if not audio_processor.WHISPER_LOADED:
        logger.warning(
            "[SafeView] analyze_audio called but Whisper is not loaded.",
        )
        base_response["whisper_loaded"] = False
        return base_response

    if not audio_bytes:
        logger.warning("[SafeView] analyze_audio received empty audio chunk.")
        return base_response

    transcribed_text = audio_processor.transcribe_audio(
        audio_bytes,
        language,
        audio_format=audio_format,
    )
    print(f"!!! WHISPER HEARD: '{transcribed_text}'")

    result = profanity_service.check_profanity(
        transcribed_text,
        language,
        extra_words=extra_words,
    )

    if result["detected"]:
        return {
            "category": CATEGORY,
            "detected": True,
            "action": ACTION_BEEP,
            "audio_action": AUDIO_ACTION_BEEP,
            "duration_ms": MUTE_DURATION_MS,
            "whisper_loaded": True,
            "confidence": 1.0,
            "transcribed_text": transcribed_text,
        }

    return {
        "category": CATEGORY,
        "detected": False,
        "action": ACTION_ALLOW,
        "audio_action": ACTION_ALLOW,
        "duration_ms": 0,
        "whisper_loaded": True,
        "confidence": 0.0,
        "transcribed_text": transcribed_text,
    }


def analyze(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Image-frame profanity hook — visual frames are not transcribed here.

    Profanity for audio uses POST /analyze-audio (analyze_audio). This path
    fail-opens so /analyze-image category=profanity stays compatible.

    Args:
        image: Decoded JPEG frame from the client (not used for text detection).
        sensitivity: User-configured sensitivity (0.0–1.0).

    Returns:
        dict: category, detected=False, confidence=0.0, action ALLOW.
    """
    _ = image, sensitivity
    return {
        "category": CATEGORY,
        "detected": False,
        "confidence": 0.0,
        "action": ACTION_ALLOW,
    }
