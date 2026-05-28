# SafeView — romance_inference.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: MobileNetV2 romance/kissing classifier and BR-01 thresholding.

from __future__ import annotations

import logging
from typing import Any, Dict

import numpy as np
from PIL import Image

import romance_loader

logger = logging.getLogger(__name__)

ACTION_BLUR = "BLUR"
ACTION_ALLOW = "ALLOW"


def normalize_sensitivity(sensitivity: float) -> float:
    """Clamp the UI sensitivity to the valid confidence range."""
    return max(0.0, min(1.0, float(sensitivity)))


def preprocess_image(image: Image.Image) -> np.ndarray:
    """
    Resize to 224x224 RGB and scale pixels to 0–255 float32.

    Normalization (/255, mean subtraction) is inside the saved Keras graph.
    """
    rgb = image.convert("RGB").resize(
        (romance_loader.INPUT_SIZE, romance_loader.INPUT_SIZE),
        Image.Resampling.BILINEAR,
    )
    array = np.asarray(rgb, dtype=np.float32)
    return np.expand_dims(array, axis=0)


def run_detection(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Run romance/kissing classification and apply the UI sensitivity threshold.

    Returns sigmoid romance probability as confidence.
    """
    model = romance_loader.get_model()
    if model is None or not romance_loader.MODEL_LOADED:
        return {
            "confidence": 0.0,
            "detected": False,
            "action": ACTION_ALLOW,
            "label": "SFW",
        }

    effective_threshold = normalize_sensitivity(sensitivity)

    try:
        batch = preprocess_image(image)
        raw = model.predict(batch, verbose=0)
        romance_score = float(np.squeeze(raw))
    except Exception as exc:
        logger.error("[SafeView] Romance inference failed: %s", exc)
        return {
            "confidence": 0.0,
            "detected": False,
            "action": ACTION_ALLOW,
            "label": "SFW",
        }

    romance_score = max(0.0, min(1.0, romance_score))
    detected = romance_score >= effective_threshold
    action = ACTION_BLUR if detected else ACTION_ALLOW
    label = "NSFW" if detected else "SFW"

    return {
        "confidence": romance_score,
        "detected": detected,
        "action": action,
        "label": label,
    }
