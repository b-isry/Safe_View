# SafeView — tests/test_api.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Pytest coverage for /health, /analyze-image, BR-01, and stub models.

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import inference
import model_loader
from models import kissing, lgbtq, profanity, violence

ANALYZE_RESPONSE_KEYS = {
    "category",
    "detected",
    "confidence",
    "action",
    "model_loaded",
}
HEALTH_RESPONSE_KEYS = {"status", "model", "model_loaded"}


def test_health_response_shape(client: TestClient) -> None:
    """
    GET /health returns 200 with status, model name, and model_loaded flag.
    """
    response = client.get("/health")
    assert response.status_code == 200
    body: Dict[str, Any] = response.json()
    assert set(body.keys()) == HEALTH_RESPONSE_KEYS
    assert body["status"] == "ok"
    assert body["model"] == model_loader.MODEL_NAME
    assert isinstance(body["model_loaded"], bool)


def test_analyze_image_blank_jpeg_response_shape(
    client: TestClient,
    blank_jpeg_bytes: bytes,
) -> None:
    """
    POST /analyze-image with a blank white JPEG returns a valid response shape.
    """
    response = client.post(
        "/analyze-image",
        files={"frame": ("blank.jpg", blank_jpeg_bytes, "image/jpeg")},
        data={"sensitivity": "0.75", "category": "nudity"},
    )
    assert response.status_code == 200
    body: Dict[str, Any] = response.json()
    assert set(body.keys()) == ANALYZE_RESPONSE_KEYS
    assert body["category"] == "nudity"
    assert body["action"] in ("BLUR", "ALLOW")
    assert isinstance(body["detected"], bool)
    assert isinstance(body["confidence"], float)
    assert 0.0 <= body["confidence"] <= 1.0
    assert isinstance(body["model_loaded"], bool)


def test_br01_threshold_floor_low_sensitivity() -> None:
    """
    BR-01: sensitivity=0.1 still uses effective threshold 0.75 (not 0.1).
    """
    low_sensitivity = 0.1
    effective = max(inference.CONFIDENCE_FLOOR, low_sensitivity)
    assert effective == inference.CONFIDENCE_FLOOR

    mock_model = MagicMock()
    mock_model.training = False
    mock_model.eval = MagicMock()
    # confidence 0.72 after sigmoid — above 0.1 but below BR-01 floor 0.75
    mock_model.return_value = __import__("torch").tensor([[0.0, 0.97]])

    tensor = __import__("torch").zeros(1, 3, 224, 224)

    with patch.object(model_loader, "get_model", return_value=mock_model), patch.object(
        model_loader, "MODEL_LOADED", True
    ):
        result = inference.run_inference(tensor, low_sensitivity)

    assert result["detected"] is False
    assert result["action"] == inference.ACTION_ALLOW
    assert result["confidence"] == pytest.approx(0.7253, rel=1e-2)


@pytest.mark.parametrize(
    "module,expected_category",
    [
        (violence, "violence"),
        (kissing, "kissing"),
        (profanity, "profanity"),
        (lgbtq, "lgbtq"),
    ],
)
def test_stub_modules_return_no_detection(
    module: Any,
    expected_category: str,
    blank_jpeg_bytes: bytes,
) -> None:
    """
    Each stub category module always returns detected=False and action ALLOW.
    """
    from PIL import Image
    import io

    image = Image.open(io.BytesIO(blank_jpeg_bytes))
    try:
        result = module.analyze(image, sensitivity=0.75)
    finally:
        image.close()

    assert result["category"] == expected_category
    assert result["detected"] is False
    assert result["confidence"] == 0.0
    assert result["action"] == "ALLOW"


@pytest.mark.parametrize("category", ["violence", "kissing", "profanity", "lgbtq"])
def test_analyze_image_stubs_via_api(
    client: TestClient,
    blank_jpeg_bytes: bytes,
    category: str,
) -> None:
    """
    POST /analyze-image for stub categories returns detected=False through the API.
    """
    response = client.post(
        "/analyze-image",
        files={"frame": ("blank.jpg", blank_jpeg_bytes, "image/jpeg")},
        data={"sensitivity": "0.75", "category": category},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["category"] == category
    assert body["detected"] is False
    assert body["confidence"] == 0.0
    assert body["action"] == "ALLOW"
