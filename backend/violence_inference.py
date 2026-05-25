# SafeView — violence_inference.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: YOLO object detection for fight / weapon / blood with normalized bounding boxes.

from __future__ import annotations

import logging
from typing import Any, Dict, List

from PIL import Image

import violence_loader

logger = logging.getLogger(__name__)

DEFAULT_VIOLENCE_THRESHOLD = 0.50
YOLO_MIN_BOX_CONF = 0.1

ACTION_BLUR = "BLUR"
ACTION_ALLOW = "ALLOW"


def run_detection(image: Image.Image, sensitivity: float) -> Dict[str, Any]:
    """
    Run YOLO violence detection and return normalized boxes.

    Args:
        image: RGB frame from the client.
        sensitivity: User sensitivity; effective threshold is max(0.50, sensitivity) capped at 1.0.

    Returns:
        dict with detected, confidence, action, label, detections (with box when available).
    """
    model = violence_loader.get_model()
    if model is None or not violence_loader.MODEL_LOADED:
        return {
            "confidence": 0.0,
            "detected": False,
            "action": ACTION_ALLOW,
            "label": "MODEL_NOT_LOADED",
            "detections": [],
            "gate_reason": "violence_model_not_loaded",
        }

    effective_threshold = max(DEFAULT_VIOLENCE_THRESHOLD, min(1.0, float(sensitivity)))
    rgb_image = image.convert("RGB")
    width, height = rgb_image.size

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
            "label": "SAFE",
            "detections": [],
        }

    detections: List[Dict[str, Any]] = []
    max_confidence = 0.0

    if results:
        result = results[0]
        names = getattr(result, "names", None) or getattr(model, "names", {}) or {}
        boxes = getattr(result, "boxes", None)

        if boxes is not None and len(boxes):
            for index in range(len(boxes)):
                confidence = float(boxes.conf[index].item())
                if confidence < effective_threshold:
                    continue

                class_id = int(boxes.cls[index].item())
                if isinstance(names, dict):
                    class_name = names.get(class_id, str(class_id))
                else:
                    class_name = str(class_id)

                x1, y1, x2, y2 = boxes.xyxy[index].tolist()
                norm_box = [
                    max(0.0, min(1.0, x1 / width)),
                    max(0.0, min(1.0, y1 / height)),
                    max(0.0, min(1.0, x2 / width)),
                    max(0.0, min(1.0, y2 / height)),
                ]

                if norm_box[2] <= norm_box[0] or norm_box[3] <= norm_box[1]:
                    continue

                detections.append(
                    {
                        "class": class_name,
                        "confidence": confidence,
                        "box": norm_box,
                    }
                )
                if confidence > max_confidence:
                    max_confidence = confidence

    detected = len(detections) > 0
    action = ACTION_BLUR if detected else ACTION_ALLOW
    label = "VIOLENCE" if detected else "SAFE"

    return {
        "confidence": max_confidence,
        "detected": detected,
        "action": action,
        "label": label,
        "detections": detections,
    }
