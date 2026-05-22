# SafeView — tests/conftest.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Shared pytest fixtures for backend API tests.

from __future__ import annotations

import io
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image

# Avoid loading the Whisper checkpoint during test collection/import.
with patch("audio_processor.load_whisper"):
    import audio_processor

    audio_processor.WHISPER_LOADED = False
    audio_processor._whisper_model = None

import main


@pytest.fixture(scope="session")
def client() -> TestClient:
    """
    FastAPI test client bound to the SafeView backend app.

    Returns:
        TestClient: HTTP client for route integration tests.
    """
    return TestClient(main.app)


@pytest.fixture
def silent_webm_bytes() -> bytes:
    """
    Minimal WebM upload bytes (EBML header + padding) for /analyze-audio tests.

    Transcription is mocked in tests; bytes mimic a silent MediaRecorder chunk.
    """
    return (
        bytes.fromhex("1a45dfa3010000000000000015428680")
        + b"\x00" * 64
    )


@pytest.fixture
def blank_jpeg_bytes() -> bytes:
    """
    Build a minimal blank white JPEG for /analyze-image uploads.

    Returns:
        bytes: JPEG image bytes.
    """
    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), color=(255, 255, 255)).save(buffer, format="JPEG")
    return buffer.getvalue()
