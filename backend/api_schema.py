# SafeView — api_schema.py
# Purpose: Stable /analyze-image response normalization for extension and Android clients.

from __future__ import annotations

from typing import Any, Dict, List, Optional

ACTION_ALLOW = "ALLOW"
ACTION_BLUR = "BLUR"

CATEGORY_SUPPORTS_BOXES: Dict[str, bool] = {
    "nudity": False,
    "violence": True,
    "all": True,
}


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def normalize_box(box: Any) -> Optional[List[float]]:
    """Normalize a detection box to [x1, y1, x2, y2] in [0, 1]."""
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        return None

    try:
        x1, y1, x2, y2 = (_clamp01(float(box[0])), _clamp01(float(box[1])), _clamp01(float(box[2])), _clamp01(float(box[3])))
    except (TypeError, ValueError):
        return None

    if x2 <= x1 or y2 <= y1:
        return None

    return [x1, y1, x2, y2]


def normalize_detection(entry: Any) -> Optional[Dict[str, Any]]:
    """Normalize one detection dict; drop invalid entries."""
    if not isinstance(entry, dict):
        return None

    confidence_raw = entry.get("confidence")
    try:
        confidence = float(confidence_raw)
    except (TypeError, ValueError):
        return None

    class_name = entry.get("class")
    if not isinstance(class_name, str):
        class_name = str(class_name) if class_name is not None else "unknown"

    normalized: Dict[str, Any] = {
        "class": class_name,
        "confidence": confidence,
    }

    box = normalize_box(entry.get("box"))
    if box is not None:
        normalized["box"] = box

    return normalized


def normalize_detections(raw: Any) -> List[Dict[str, Any]]:
    """Return a list of normalized detection objects (may be empty)."""
    if not isinstance(raw, list):
        return []

    out: List[Dict[str, Any]] = []
    for entry in raw:
        normalized = normalize_detection(entry)
        if normalized is not None:
            out.append(normalized)
    return out


def normalize_analyze_response(result: Dict[str, Any], category: str) -> Dict[str, Any]:
    """
    Ensure every /analyze-image response matches the API contract.

    Preserves detections, content_type, gate_reason, supports_boxes, model_loaded, label.
    """
    cat = str(result.get("category", category))
    raw_label = result.get("label", "SFW")
    label = raw_label if isinstance(raw_label, str) else "SFW"

    action_raw = result.get("action", ACTION_ALLOW)
    action = ACTION_BLUR if action_raw == ACTION_BLUR else ACTION_ALLOW

    content_type = result.get("content_type")
    if content_type is not None and not isinstance(content_type, dict):
        content_type = None

    gate_reason = result.get("gate_reason")
    if gate_reason is not None and not isinstance(gate_reason, str):
        gate_reason = None

    supports_boxes = result.get("supports_boxes")
    if not isinstance(supports_boxes, bool):
        supports_boxes = CATEGORY_SUPPORTS_BOXES.get(cat, False)

    normalized: Dict[str, Any] = {
        "category": cat,
        "detected": bool(result.get("detected", False)),
        "confidence": float(result.get("confidence", 0.0)),
        "action": action,
        "label": label,
        "model_loaded": bool(result.get("model_loaded", False)),
        "detections": normalize_detections(result.get("detections")),
        "content_type": content_type,
        "gate_reason": gate_reason,
        "supports_boxes": supports_boxes,
    }

    categories = result.get("categories")
    if isinstance(categories, dict):
        normalized["categories"] = {
            key: normalize_analyze_response(value, str(key))
            for key, value in categories.items()
            if isinstance(value, dict)
        }

    return normalized


def build_fail_open(category: str, *, model_loaded: bool = False, gate_reason: str | None = None) -> Dict[str, Any]:
    """Fail-open ALLOW response with empty detections."""
    return normalize_analyze_response(
        {
            "category": category,
            "detected": False,
            "confidence": 0.0,
            "action": ACTION_ALLOW,
            "label": "SFW",
            "model_loaded": model_loaded,
            "detections": [],
            "content_type": None,
            "gate_reason": gate_reason,
            "supports_boxes": CATEGORY_SUPPORTS_BOXES.get(category, False),
        },
        category,
    )


def merge_category_results(
    nudity: Dict[str, Any],
    violence: Dict[str, Any],
) -> Dict[str, Any]:
    """Build composite category=all response from nudity and violence results."""
    categories = {
        "nudity": normalize_analyze_response(nudity, "nudity"),
        "violence": normalize_analyze_response(violence, "violence"),
    }

    detected = any(entry["detected"] for entry in categories.values())
    action = ACTION_BLUR if any(entry["action"] == ACTION_BLUR for entry in categories.values()) else ACTION_ALLOW
    confidence = max(entry["confidence"] for entry in categories.values()) if categories else 0.0
    label = "UNSAFE" if detected else "SAFE"
    model_loaded = all(entry["model_loaded"] for entry in categories.values())

    detections: List[Dict[str, Any]] = []
    for entry in categories.values():
        detections.extend(entry.get("detections", []))

    return normalize_analyze_response(
        {
            "category": "all",
            "detected": detected,
            "confidence": confidence,
            "action": action,
            "label": label,
            "model_loaded": model_loaded,
            "detections": detections,
            "content_type": None,
            "gate_reason": None,
            "supports_boxes": True,
            "categories": categories,
        },
        "all",
    )
