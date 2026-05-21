# SafeView — tests/conftest.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Shared pytest fixtures for backend API tests.

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

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
def blank_jpeg_bytes() -> bytes:
    """
    Build a minimal blank white JPEG for /analyze-image uploads.

    Returns:
        bytes: JPEG image bytes.
    """
    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), color=(255, 255, 255)).save(buffer, format="JPEG")
    return buffer.getvalue()
