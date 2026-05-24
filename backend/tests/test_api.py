# SafeView — tests/test_api.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Pytest coverage for /health, /analyze-image, BR-01, and stub models.

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import audio_processor
import inference
import main
import model_loader
import violence_loader
from models import kissing, lgbtq, profanity, violence

ANALYZE_RESPONSE_KEYS = {
    "category",
    "detected",
    "confidence",
    "action",
    "model_loaded",
    "label",
    "gate_reason",
    "content_type",
}
HEALTH_RESPONSE_KEYS = {"status", "model", "model_loaded", "whisper_loaded"}


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
    assert isinstance(body["whisper_loaded"], bool)


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
    assert isinstance(body["gate_reason"], str)
    content_type = body["content_type"]
    assert isinstance(content_type, dict)
    assert isinstance(content_type.get("is_animation"), bool)
    assert isinstance(content_type.get("is_real_human"), bool)


def test_br01_threshold_floor_low_sensitivity() -> None:
    """
    BR-01: sensitivity=0.1 still uses effective threshold floor (not 0.1).
    """
    low_sensitivity = 0.1
    effective = max(inference.CONFIDENCE_FLOOR, low_sensitivity)
    assert effective == inference.CONFIDENCE_FLOOR

    mock_model = MagicMock()
    mock_model.training = False
    mock_model.eval = MagicMock()
    # confidence ~0.38 after sigmoid — above 0.1 but below BR-01 floor
    mock_model.return_value = __import__("torch").tensor([[0.0, -0.5]])

    tensor = __import__("torch").zeros(1, 3, 224, 224)

    with patch.object(model_loader, "get_model", return_value=mock_model), patch.object(
        model_loader, "MODEL_LOADED", True
    ):
        result = inference.run_inference(tensor, low_sensitivity)

    assert result["detected"] is False
    assert result["action"] == inference.ACTION_ALLOW
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


@pytest.mark.parametrize(
    "module,expected_category",
    [
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
    assert body["category"] == "violence"
    assert body["action"] in ("BLUR", "ALLOW")
    assert isinstance(body["detected"], bool)
    assert isinstance(body["confidence"], float)
    assert 0.0 <= body["confidence"] <= 1.0
    assert isinstance(body["model_loaded"], bool)


@pytest.mark.parametrize("category", ["kissing", "profanity", "lgbtq"])
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


def test_analyze_audio_silent_webm_chunk_detected_false(
    client: TestClient,
    silent_webm_bytes: bytes,
) -> None:
    """
    POST /analyze-audio with a silent WebM chunk returns detected=false and valid shape.
    """
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
    assert set(body.keys()) == main.ANALYZE_AUDIO_RESPONSE_KEYS
    assert body["detected"] is False
    assert body["action"] == "ALLOW"
    assert body["duration_ms"] == 0
    assert body["whisper_loaded"] is True
    assert isinstance(body["action"], str)


@pytest.mark.parametrize(
    "whisper_loaded,transcript,expected_detected,expected_action",
    [
        (True, "", False, "ALLOW"),
        (True, "what the fuck", True, "MUTE"),
        (False, "", False, "ALLOW"),
    ],
)
def test_analyze_audio_duration_ms_br05(
    client: TestClient,
    silent_webm_bytes: bytes,
    whisper_loaded: bool,
    transcript: str,
    expected_detected: bool,
    expected_action: str,
) -> None:
    """
    MUTE responses use 3500 ms; ALLOW responses use 0 ms.
    """
    with patch.object(audio_processor, "WHISPER_LOADED", whisper_loaded), patch.object(
        audio_processor,
        "transcribe_audio",
        return_value=transcript,
    ):
        response = client.post(
            "/analyze-audio",
            files={
                "audio_chunk": ("chunk.webm", silent_webm_bytes, "audio/webm"),
            },
            data={"language": "en", "sensitivity": "0.75"},
        )

    assert response.status_code == 200
    body = response.json()
    if expected_action == "MUTE":
        assert body["duration_ms"] == 3500
    else:
        assert body["duration_ms"] == 0
    assert body["detected"] is expected_detected
    assert body["action"] == expected_action


def test_analyze_audio_detected_via_api(
    client: TestClient,
) -> None:
    """
    POST /analyze-audio returns MUTE when transcription matches the blacklist.
    """
    with patch.object(audio_processor, "WHISPER_LOADED", True), patch.object(
        audio_processor, "transcribe_audio", return_value="what the fuck"
    ):
        response = client.post(
            "/analyze-audio",
            files={"audio_chunk": ("chunk.webm", b"fake-webm", "audio/webm")},
            data={"language": "en", "sensitivity": "0.75"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["detected"] is True
    assert body["action"] == "MUTE"
    assert body["duration_ms"] == 3500
    """POST /analyze-audio rejects unsupported language codes."""
    response = client.post(
        "/analyze-audio",
        files={"audio_chunk": ("chunk.webm", b"\x00", "audio/webm")},
        data={"language": "fr", "sensitivity": "0.75"},
    )
    assert response.status_code == 400


def test_profanity_analyze_audio_module() -> None:
    """profanity.analyze_audio wires transcription and blacklist detection."""
    with patch.object(audio_processor, "WHISPER_LOADED", True), patch.object(
        audio_processor, "transcribe_audio", return_value="clean speech"
    ):
        result = profanity.analyze_audio(b"audio", "en", 0.75)

    assert result["detected"] is False
    assert result["action"] == "ALLOW"
    assert result["duration_ms"] == 0
    assert result["whisper_loaded"] is True
