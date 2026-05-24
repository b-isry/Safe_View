# SafeView — violence_inference.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: YOLO object detection for fight / weapon / blood and BR-01 thresholding.

from __future__ import annotations

import logging
from typing import Any, Dict, List

from PIL import Image

import violence_loader

logger = logging.getLogger(__name__)

# BR-01: minimum confidence regardless of user sensitivity
CONFIDENCE_FLOOR = 0.75

# Minimum box confidence passed to YOLO predict (filter in Python for final decision)
YOLO_MIN_BOX_CONF = 0.1

ACTION_BLUR = "BLUR"
ACTION_ALLOW = "ALLOW"


def run_detection(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Run YOLO violence detection and apply BR-01 threshold.

    Returns max box confidence across fight / weapon / blood detections.
    """
    model = violence_loader.get_model()
    if model is None or not violence_loader.MODEL_LOADED:
        return {
            "confidence": 0.0,
            "detected": False,
            "action": ACTION_ALLOW,
            "label": "SFW",
            "detections": [],
        }

    effective_threshold = max(CONFIDENCE_FLOOR, sensitivity)
    rgb_image = image.convert("RGB")

    try:
        results = model.predict(
            rgb_image,
            verbose=False,
            conf=YOLO_MIN_BOX_CONF,
        )
    except Exception as exc:
        logger.error("[SafeView] Violence inference failed: %s", exc)
        return {
            "confidence": 0.0,
            "detected": False,
            "action": ACTION_ALLOW,
            "label": "SFW",
            "detections": [],
        }

    max_confidence = 0.0
    detections: List[Dict[str, Any]] = []

    if results:
        result = results[0]
        names = result.names or {}
        boxes = result.boxes
        if boxes is not None and len(boxes):
            for index in range(len(boxes)):
                confidence = float(boxes.conf[index].item())
                class_id = int(boxes.cls[index].item())
                class_name = names.get(class_id, str(class_id))
                detections.append(
                    {
                        "class": class_name,
                        "confidence": confidence,
                    }
                )
                if confidence > max_confidence:
                    max_confidence = confidence

    detected = max_confidence >= effective_threshold
    action = ACTION_BLUR if detected else ACTION_ALLOW
    label = "NSFW" if detected else "SFW"

    return {
        "confidence": max_confidence,
        "detected": detected,
        "action": action,
        "label": label,
        "detections": detections,
    }
