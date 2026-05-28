# SafeView — models/violence.py
# Purpose: Violence detection via YOLO (fight, weapon, blood) in violence.pt.

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
    Detect violent content with YOLO; returns normalized bounding boxes when present.
    """
    if violence_loader.get_model() is None:
        logger.warning(
            "[SafeView] Violence analyze called but weights could not be loaded; failing open.",
        )
        return _fail_open_response()

    try:
        raw = violence_inference.run_detection(image, sensitivity)
        if raw["detected"]:
            classes = ", ".join(
                str(entry.get("class", "?")) for entry in raw.get("detections", [])
            )
            logger.info(
                "[SafeView][Violence] detected label=%s confidence=%.3f boxes=%s classes=%s",
                raw["label"],
                float(raw["confidence"]),
                len(raw.get("detections", [])),
                classes or "-",
            )
        return {
            "category": CATEGORY,
            "detected": raw["detected"],
            "confidence": raw["confidence"],
            "action": raw["action"],
            "label": raw["label"],
            "model_loaded": True,
            "detections": raw.get("detections", []),
            "content_type": None,
            "gate_reason": raw.get("gate_reason"),
            "supports_boxes": True,
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
        "label": "SAFE",
        "model_loaded": violence_loader.MODEL_LOADED,
        "detections": [],
        "content_type": None,
        "gate_reason": "violence_model_not_loaded" if not violence_loader.MODEL_LOADED else None,
        "supports_boxes": True,
    }