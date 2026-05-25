# SafeView — models/nudity.py
# Purpose: Nudity classification via dino_v3_linear.pth (full-frame blur only; no boxes).

from __future__ import annotations

import logging
from typing import Any, Dict

from PIL import Image

import content_gate
import inference
import model_loader

logger = logging.getLogger(__name__)

CATEGORY = "nudity"
UNSAFE_THRESHOLD = content_gate.UNSAFE_THRESHOLD


def analyze(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Run nudity classifier first; content gate is metadata unless model is strongly NSFW.

    High-confidence NSFW from the classifier always triggers BLUR (no partial-region boxes).
    """
    del sensitivity  # Threshold fixed at UNSAFE_THRESHOLD for nudity classifier.

    if not model_loader.MODEL_LOADED or model_loader.get_model() is None:
        logger.warning(
            "[SafeView] Nudity analyze called but %s is not loaded; failing open.",
            model_loader.MODEL_FILENAME,
        )
        return _fail_open_response()

    try:
        content_type = content_gate.classify_content_type(image)
        tensor = inference.preprocess(image)
        raw = inference.run_inference_raw(tensor)
        nudity_positive = raw["label"] == "NSFW"
        confidence = float(raw["confidence"])

        # Trust classifier when confidence is high — do not block on weak heuristics.
        if nudity_positive and confidence >= UNSAFE_THRESHOLD:
            return {
                "category": CATEGORY,
                "detected": True,
                "confidence": confidence,
                "action": inference.ACTION_BLUR,
                "label": "NSFW",
                "model_loaded": True,
                "detections": [],
                "content_type": content_type,
                "gate_reason": "classifier_nsfw",
                "supports_boxes": False,
            }

        gated = content_gate.build_gated_nudity_response(
            content_type,
            nudity_confidence=confidence,
            nudity_positive=nudity_positive,
            model_loaded=True,
        )

        return {
            "category": CATEGORY,
            **gated,
            "detections": [],
            "supports_boxes": False,
        }
    except Exception as exc:
        logger.error("[SafeView] Nudity detection failed: %s", exc)
        return _fail_open_response()


def _fail_open_response() -> Dict[str, Any]:
    """Fail-open when model unavailable or inference errors."""
    return {
        "category": CATEGORY,
        "detected": False,
        "confidence": 0.0,
        "action": inference.ACTION_ALLOW,
        "label": "SFW",
        "model_loaded": model_loader.MODEL_LOADED,
        "detections": [],
        "content_type": None,
        "gate_reason": "model_unavailable",
        "supports_boxes": False,
    }
