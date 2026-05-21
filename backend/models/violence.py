# SafeView — models/violence.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Stub violence detection module (placeholder until a real model is integrated).

# TODO: Replace this stub with a real trained model.
# Interface contract:
#   Input:  PIL Image, sensitivity: float (0.0–1.0)
#   Output: { "category": str, "detected": bool, "confidence": float, "action": "BLUR"|"ALLOW" }

from __future__ import annotations

import logging
from typing import Any, Dict

from PIL import Image

logger = logging.getLogger(__name__)

CATEGORY = "violence"
ACTION_ALLOW = "ALLOW"


def analyze(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Stub violence analyzer — always returns no detection until replaced.

    Args:
        image: Decoded JPEG frame from the client.
        sensitivity: User-configured sensitivity (0.0–1.0).

    Returns:
        dict: Stub result with detected=False and action ALLOW.
    """
    logger.warning("[SafeView][StubModel] returning no detection")
    return {
        "category": CATEGORY,
        "detected": False,
        "confidence": 0.0,
        "action": ACTION_ALLOW,
    }
