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
from typing import Any, Dict

from PIL import Image

import audio_processor
import profanity_filter

logger = logging.getLogger(__name__)

CATEGORY = "profanity"
ACTION_ALLOW = "ALLOW"
ACTION_MUTE = "MUTE"
# BR-05: client mute duration when profanity is detected
MUTE_DURATION_MS = 1500


def analyze_audio(
    audio_bytes: bytes,
    language: str,
    sensitivity: float,
) -> Dict[str, Any]:
    """
    Transcribe WebM audio and run blacklist profanity detection.

    Args:
        audio_bytes: WebM/Opus chunk from MediaRecorder.
        language: Whisper language code — "en" or "am".
        sensitivity: Unused for profanity; kept for API consistency.

    Returns:
        dict: detected, action (MUTE | ALLOW), duration_ms, whisper_loaded.
    """
    _ = sensitivity

    base_response: Dict[str, Any] = {
        "detected": False,
        "action": ACTION_ALLOW,
        "duration_ms": MUTE_DURATION_MS,
        "whisper_loaded": audio_processor.WHISPER_LOADED,
        "confidence": 0.0,
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

    text = audio_processor.transcribe_audio(audio_bytes, language)
    result = profanity_filter.detect_profanity(text, language)

    if result["detected"]:
        return {
            "detected": True,
            "action": result.get("action", ACTION_MUTE),
            "duration_ms": MUTE_DURATION_MS,
            "whisper_loaded": True,
            "confidence": 1.0,
        }

    return {
        "detected": False,
        "action": ACTION_ALLOW,
        "duration_ms": MUTE_DURATION_MS,
        "whisper_loaded": True,
        "confidence": 0.0,
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
