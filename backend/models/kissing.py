# SafeView — models/kissing.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Kissing/romantic content detection via romance_classifier_final.keras.

from __future__ import annotations

import logging
from typing import Any, Dict

from PIL import Image

import romance_inference
import romance_loader

logger = logging.getLogger(__name__)

CATEGORY = "kissing"


def analyze(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Detect kissing/romantic content with the MobileNetV2 romance classifier.

    Args:
        image: Decoded JPEG frame from the client.
        sensitivity: User sensitivity (0.0–1.0) used directly as threshold.

    Returns:
        dict: category, detected, confidence, action, label, model_loaded.
    """
    if not romance_loader.MODEL_LOADED or romance_loader.get_model() is None:
        logger.warning(
            "[SafeView] Kissing analyze called but %s is not loaded; failing open.",
            romance_loader.MODEL_FILENAME,
        )
        return _fail_open_response()

    try:
        raw = romance_inference.run_detection(image, sensitivity)
        return {
            "category": CATEGORY,
            "detected": raw["detected"],
            "confidence": raw["confidence"],
            "action": raw["action"],
            "label": raw["label"],
            "model_loaded": True,
        }
    except Exception as exc:
        logger.error("[SafeView] Kissing detection failed: %s", exc)
        return _fail_open_response()


def _fail_open_response() -> Dict[str, Any]:
    """Fail-open when weights are missing or inference errors."""
    return {
        "category": CATEGORY,
        "detected": False,
        "confidence": 0.0,
        "action": romance_inference.ACTION_ALLOW,
        "label": "SFW",
        "model_loaded": romance_loader.MODEL_LOADED,
    }
