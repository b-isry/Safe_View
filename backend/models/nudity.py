# SafeView — models/nudity.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Real nudity detection using the team-provided dino_v3_linear.pth weights.

from __future__ import annotations

import logging
from typing import Any, Dict

from PIL import Image

import inference
import model_loader

logger = logging.getLogger(__name__)

CATEGORY = "nudity"


def analyze(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Run nudity inference on a single frame via model_loader + inference pipeline.

    Interface contract:
        Input:  PIL Image, sensitivity: float (0.0–1.0)
        Output: {
            "category": str,
            "detected": bool,
            "confidence": float,
            "action": "BLUR" | "ALLOW",
            "model_loaded": bool,
        }

    Args:
        image: Decoded JPEG frame from the client.
        sensitivity: User-configured sensitivity (BR-01 floor applied in inference).

    Returns:
        dict: Detection result for the nudity category.
    """
    if not model_loader.MODEL_LOADED or model_loader.get_model() is None:
        logger.warning(
            "[SafeView] Nudity analyze called but %s is not loaded; failing open.",
            model_loader.MODEL_FILENAME,
        )
        return _fail_open_response()

    try:
        tensor = inference.preprocess(image)
        result = inference.run_inference(tensor, sensitivity)
        return {
            "category": CATEGORY,
            "detected": result["detected"],
            "confidence": result["confidence"],
            "action": result["action"],
            "label": result.get("label", "SFW"),
            "model_loaded": True,
        }
    except Exception as exc:
        logger.error("[SafeView] Nudity detection failed: %s", exc)
        return _fail_open_response()


def _fail_open_response() -> Dict[str, Any]:
    """
    Build a fail-open API response when the model is unavailable or inference errors.

    Returns:
        dict: No detection, zero confidence, ALLOW action, model_loaded=False.
    """
    return {
        "category": CATEGORY,
        "detected": False,
        "confidence": 0.0,
        "action": inference.ACTION_ALLOW,
        "label": "SFW",
        "model_loaded": model_loader.MODEL_LOADED,
    }
