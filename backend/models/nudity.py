# SafeView — models/nudity.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Real nudity detection with animation/human content gate.

from __future__ import annotations

import logging
from typing import Any, Dict

from PIL import Image

import content_gate
import inference
import model_loader

logger = logging.getLogger(__name__)

CATEGORY = "nudity"


def analyze(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Run content gate then nudity inference on real-human frames only.

    Animation/cartoon/anime frames return ALLOW immediately (no nudity blur).
    Person/face/skin alone never triggers blur — only gated nudity >= 0.72.
    """
    del sensitivity  # Final threshold is UNSAFE_THRESHOLD in content_gate.

    if not model_loader.MODEL_LOADED or model_loader.get_model() is None:
        logger.warning(
            "[SafeView] Nudity analyze called but %s is not loaded; failing open.",
            model_loader.MODEL_FILENAME,
        )
        return _fail_open_response()

    try:
        content_type = content_gate.classify_content_type(image)

        if content_type.get("is_animation") or not content_type.get("is_real_human"):
            return {
                "category": CATEGORY,
                **content_gate.build_gated_nudity_response(
                    content_type,
                    nudity_confidence=0.0,
                    nudity_positive=False,
                    model_loaded=True,
                ),
            }

        tensor = inference.preprocess(image)
        raw = inference.run_inference_raw(tensor)
        nudity_positive = raw["label"] == "NSFW"

        gated = content_gate.build_gated_nudity_response(
            content_type,
            nudity_confidence=raw["confidence"],
            nudity_positive=nudity_positive,
            model_loaded=True,
        )

        return {
            "category": CATEGORY,
            **gated,
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
        "gate_reason": "model_unavailable",
        "content_type": {
            "is_animation": False,
            "is_real_human": False,
            "gate_reason": "model_unavailable",
        },
    }
