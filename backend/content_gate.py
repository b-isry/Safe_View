# SafeView — content_gate.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Animation/cartoon skip and real-human gate before nudity blur decisions.

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Tuple

from PIL import Image

logger = logging.getLogger(__name__)

UNSAFE_THRESHOLD = 0.72
GATE_SAMPLE_SIZE = 128

# Heuristic thresholds tuned for cartoon/anime vs live-action footage.
_ANIMATION_UNIQUE_RATIO_MAX = 0.18
_ANIMATION_AVG_SATURATION_MIN = 0.32
_ANIMATION_FLAT_LUMINANCE_MAX = 0.07
_PHOTO_UNIQUE_RATIO_MIN = 0.22
_PHOTO_LUMINANCE_VAR_MIN = 0.055


def _rgb_to_hsv(r: float, g: float, b: float) -> Tuple[float, float, float]:
    """Convert RGB in [0,1] to HSV."""
    mx = max(r, g, b)
    mn = min(r, g, b)
    diff = mx - mn

    if diff == 0:
        h = 0.0
    elif mx == r:
        h = ((g - b) / diff) % 6.0
    elif mx == g:
        h = ((b - r) / diff) + 2.0
    else:
        h = ((r - g) / diff) + 4.0
    h /= 6.0

    s = 0.0 if mx == 0 else diff / mx
    v = mx
    return h, s, v


def _variance(values: List[float]) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return sum((value - mean) ** 2 for value in values) / len(values)


def _frame_features(image: Image.Image) -> Dict[str, float]:
    """Compute lightweight color/texture features on a downscaled frame."""
    rgb = image.convert("RGB").resize(
        (GATE_SAMPLE_SIZE, GATE_SAMPLE_SIZE),
        Image.Resampling.BILINEAR,
    )
    pixels = list(rgb.getdata())
    total = len(pixels)
    unique_ratio = len(set(pixels)) / total if total else 0.0

    saturations: List[float] = []
    luminances: List[float] = []
    for red, green, blue in pixels:
        _, saturation, value = _rgb_to_hsv(red / 255.0, green / 255.0, blue / 255.0)
        saturations.append(saturation)
        luminances.append(value)

    return {
        "unique_ratio": unique_ratio,
        "avg_saturation": sum(saturations) / total if total else 0.0,
        "saturation_var": _variance(saturations),
        "luminance_var": _variance(luminances),
    }


def classify_content_type(image: Image.Image) -> Dict[str, Any]:
    """
    Classify whether a frame is animation/cartoon vs real human footage.

    Person/face/skin are NOT blur signals — this gate only decides whether
    the nudity classifier may affect blur.

    Returns:
        dict with is_animation, is_real_human, gate_reason (when gated out).
    """
    features = _frame_features(image)

    animation_score = 0.0
    if features["unique_ratio"] < _ANIMATION_UNIQUE_RATIO_MAX:
        animation_score += 0.35
    if features["avg_saturation"] > _ANIMATION_AVG_SATURATION_MIN:
        animation_score += 0.25
    if features["luminance_var"] < _ANIMATION_FLAT_LUMINANCE_MAX:
        animation_score += 0.2
    if (
        features["saturation_var"] > 0.035
        and features["luminance_var"] < 0.06
    ):
        animation_score += 0.2

    is_animation = animation_score >= 0.55
    looks_photographic = (
        features["unique_ratio"] >= _PHOTO_UNIQUE_RATIO_MIN
        or features["luminance_var"] >= _PHOTO_LUMINANCE_VAR_MIN
    )
    is_real_human = not is_animation and looks_photographic

    if is_animation:
        logger.info(
            "[SafeView][Gate] animation_skip unique=%.3f sat=%.3f lumVar=%.3f score=%.2f",
            features["unique_ratio"],
            features["avg_saturation"],
            features["luminance_var"],
            animation_score,
        )
        return {
            "is_animation": True,
            "is_real_human": False,
            "gate_reason": "animation_skip",
        }

    if not is_real_human:
        logger.info(
            "[SafeView][Gate] no_real_human unique=%.3f sat=%.3f lumVar=%.3f",
            features["unique_ratio"],
            features["avg_saturation"],
            features["luminance_var"],
        )
        return {
            "is_animation": False,
            "is_real_human": False,
            "gate_reason": "no_real_human",
        }

    return {
        "is_animation": False,
        "is_real_human": True,
        "gate_reason": None,
    }


def build_gated_nudity_response(
    content_type: Dict[str, Any],
    nudity_confidence: float,
    nudity_positive: bool,
    model_loaded: bool,
) -> Dict[str, Any]:
    """
    Apply animation/human gate and UNSAFE_THRESHOLD to raw nudity model output.

    Blur only when:
        real human AND NOT animation AND nudity positive AND confidence >= 0.72
    """
    gate_reason = content_type.get("gate_reason")

    if content_type.get("is_animation"):
        return {
            "detected": False,
            "confidence": 0.0,
            "action": "ALLOW",
            "label": "SFW",
            "gate_reason": "animation_skip",
            "content_type": content_type,
            "model_loaded": model_loaded,
        }

    if not content_type.get("is_real_human"):
        return {
            "detected": False,
            "confidence": 0.0,
            "action": "ALLOW",
            "label": "SFW",
            "gate_reason": "no_real_human",
            "content_type": content_type,
            "model_loaded": model_loaded,
        }

    if nudity_positive and nudity_confidence >= UNSAFE_THRESHOLD:
        logger.info(
            "[SafeView][Gate] real_human_nudity confidence=%.2f",
            nudity_confidence,
        )
        return {
            "detected": True,
            "confidence": nudity_confidence,
            "action": "BLUR",
            "label": "NSFW",
            "gate_reason": "real_human_nudity",
            "content_type": content_type,
            "model_loaded": model_loaded,
        }

    logger.debug(
        "[SafeView][Gate] real_human_safe confidence=%.2f positive=%s",
        nudity_confidence,
        nudity_positive,
    )
    return {
        "detected": False,
        "confidence": nudity_confidence,
        "action": "ALLOW",
        "label": "SFW" if not nudity_positive else "NSFW",
        "gate_reason": "real_human_safe",
        "content_type": content_type,
        "model_loaded": model_loaded,
    }
