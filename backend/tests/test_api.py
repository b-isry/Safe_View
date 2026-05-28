# SafeView — tests/test_api.py
# Purpose: Pytest coverage for /health, /analyze-image, and active models.

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import audio_processor
import inference
import model_loader
import paths
import violence_loader
from models import violence

ANALYZE_RESPONSE_KEYS = {
    "category",
    "detected",
    "confidence",
    "action",
    "model_loaded",
    "label",
    "detections",
    "content_type",
    "gate_reason",
    "supports_boxes",
}


def test_health_response_shape(client: TestClient) -> None:
    """GET /health returns status, backend, and per-model entries."""
    response = client.get("/health")
    assert response.status_code == 200
    body: Dict[str, Any] = response.json()
    assert body["status"] == "ok"
    assert body["backend"] == "running"
    assert "models" in body
    models = body["models"]
    assert "nudity" in models
    assert "violence" in models
    assert isinstance(models["nudity"]["loaded"], bool)
    assert isinstance(models["violence"]["loaded"], bool)
    assert models["nudity"]["supports_boxes"] is False
    assert models["violence"]["supports_boxes"] is True
    assert str(paths.NUDITY_MODEL_PATH) in models["nudity"]["path"]
    assert str(paths.VIOLENCE_MODEL_PATH) in models["violence"]["path"]
    assert isinstance(body["whisper_loaded"], bool)


def test_analyze_image_blank_jpeg_response_shape(
    client: TestClient,
    blank_jpeg_bytes: bytes,
) -> None:
    """POST /analyze-image with a blank JPEG returns the stable API contract."""
    response = client.post(
        "/analyze-image",
        files={"frame": ("blank.jpg", blank_jpeg_bytes, "image/jpeg")},
        data={"sensitivity": "0.75", "category": "nudity"},
    )
    assert response.status_code == 200
    body: Dict[str, Any] = response.json()
    assert ANALYZE_RESPONSE_KEYS.issubset(set(body.keys()))
    assert body["category"] == "nudity"
    assert body["action"] in ("BLUR", "ALLOW")
    assert isinstance(body["detected"], bool)
    assert isinstance(body["confidence"], float)
    assert 0.0 <= body["confidence"] <= 1.0
    assert isinstance(body["model_loaded"], bool)
    assert isinstance(body["detections"], list)
    assert body["supports_boxes"] is False


def test_nudity_uses_ui_sensitivity_directly() -> None:
    """Nudity detection uses the request sensitivity without a hardcoded floor."""
    low_sensitivity = 0.1
    effective = inference.normalize_sensitivity(low_sensitivity)
    assert effective == low_sensitivity

    mock_model = MagicMock()
    mock_model.training = False
    mock_model.eval = MagicMock()
    mock_model.return_value = __import__("torch").tensor([[0.0, -0.5]])

    tensor = __import__("torch").zeros(1, 3, 224, 224)

    with patch.object(model_loader, "get_model", return_value=mock_model), patch.object(
        model_loader, "MODEL_LOADED", True
    ):
        result = inference.run_inference(tensor, low_sensitivity)

    assert result["detected"] is True
    assert result["action"] == inference.ACTION_BLUR
    assert result["confidence"] == pytest.approx(0.3775, rel=1e-2)


def test_violence_module_fail_open_when_model_unloaded(
    blank_jpeg_bytes: bytes,
) -> None:
    """Violence module fails open when YOLO weights are not loaded."""
    from PIL import Image
    import io

    image = Image.open(io.BytesIO(blank_jpeg_bytes))
    try:
        with patch.object(violence_loader, "MODEL_LOADED", False), patch.object(
            violence_loader, "get_model", return_value=None
        ):
            result = violence.analyze(image, sensitivity=0.75)
    finally:
        image.close()

    assert result["category"] == "violence"
    assert result["detected"] is False
    assert result["confidence"] == 0.0
    assert result["action"] == "ALLOW"
    assert result["detections"] == []
    assert result["supports_boxes"] is True


def test_analyze_image_violence_via_api(
    client: TestClient,
    blank_jpeg_bytes: bytes,
) -> None:
    """POST /analyze-image for violence returns a valid contract on a blank frame."""
    response = client.post(
        "/analyze-image",
        files={"frame": ("blank.jpg", blank_jpeg_bytes, "image/jpeg")},
        data={"sensitivity": "0.75", "category": "violence"},
    )
    assert response.status_code == 200
    body = response.json()
    assert ANALYZE_RESPONSE_KEYS.issubset(set(body.keys()))
    assert body["category"] == "violence"
    assert body["action"] in ("BLUR", "ALLOW")
    assert isinstance(body["detections"], list)
    assert body["supports_boxes"] is True


def test_analyze_image_all_via_api(
    client: TestClient,
    blank_jpeg_bytes: bytes,
) -> None:
    """POST /analyze-image category=all returns composite categories."""
    response = client.post(
        "/analyze-image",
        files={"frame": ("blank.jpg", blank_jpeg_bytes, "image/jpeg")},
        data={"sensitivity": "0.75", "category": "all"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["category"] == "all"
    assert "categories" in body
    assert "nudity" in body["categories"]
    assert "violence" in body["categories"]


def test_analyze_image_rejects_disabled_category(
    client: TestClient,
    blank_jpeg_bytes: bytes,
) -> None:
    """Stub categories are no longer accepted on /analyze-image."""
    response = client.post(
        "/analyze-image",
        files={"frame": ("blank.jpg", blank_jpeg_bytes, "image/jpeg")},
        data={"sensitivity": "0.75", "category": "kissing"},
    )
    assert response.status_code == 400


def test_analyze_audio_silent_webm_chunk_detected_false(
    client: TestClient,
    silent_webm_bytes: bytes,
) -> None:
    """POST /analyze-audio with a silent WebM chunk returns detected=false."""
    with patch.object(audio_processor, "WHISPER_LOADED", True), patch.object(
        audio_processor, "transcribe_audio", return_value=""
    ):
        response = client.post(
            "/analyze-audio",
            files={
                "audio_chunk": ("silent.webm", silent_webm_bytes, "audio/webm"),
            },
            data={"language": "en", "sensitivity": "0.75"},
        )

    assert response.status_code == 200
    body: Dict[str, Any] = response.json()
    assert body["detected"] is False
    assert body["action"] == "ALLOW"
