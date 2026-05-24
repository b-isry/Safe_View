# SafeView — models/violence.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Violence detection via YOLO (fight, weapon, blood) in last.pt.

from __future__ import annotations

import logging
from typing import Any, Dict

from PIL import Image

import violence_inference
import violence_loader

logger = logging.getLogger(__name__)

CATEGORY = "violence"


def analyze(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Detect violent content (fight, weapon, blood) with YOLO object detection.

    Args:
        image: Decoded JPEG frame from the client.
        sensitivity: User sensitivity (0.0–1.0); BR-01 floor still applies.

    Returns:
        dict: category, detected, confidence, action, label, model_loaded.
    """
    if not violence_loader.MODEL_LOADED or violence_loader.get_model() is None:
        logger.warning(
            "[SafeView] Violence analyze called but %s is not loaded; failing open.",
            violence_loader.MODEL_FILENAME,
        )
        return _fail_open_response()

    try:
        raw = violence_inference.run_detection(image, sensitivity)
        return {
            "category": CATEGORY,
            "detected": raw["detected"],
            "confidence": raw["confidence"],
            "action": raw["action"],
            "label": raw["label"],
            "model_loaded": True,
            "detections": raw.get("detections", []),
        }
    except Exception as exc:
        logger.error("[SafeView] Violence detection failed: %s", exc)
        return _fail_open_response()


def _fail_open_response() -> Dict[str, Any]:
    """Fail-open when weights are missing or inference errors."""
    return {
        "category": CATEGORY,
        "detected": False,
        "confidence": 0.0,
        "action": violence_inference.ACTION_ALLOW,
        "label": "SFW",
        "model_loaded": violence_loader.MODEL_LOADED,
    }
