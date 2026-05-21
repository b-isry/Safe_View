# SafeView — main.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: FastAPI application entry point — CORS, routes, and startup model loading.

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from io import BytesIO
from typing import Any, AsyncIterator, Callable, Dict, List

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

import model_loader
from models import kissing, lgbtq, nudity, profanity, violence

logger = logging.getLogger(__name__)

ACTION_ALLOW = "ALLOW"
SENSITIVITY_MIN = 0.0
SENSITIVITY_MAX = 1.0

AnalyzeFn = Callable[[Image.Image, float], Dict[str, Any]]

CATEGORY_ANALYZERS: Dict[str, AnalyzeFn] = {
    nudity.CATEGORY: nudity.analyze,
    violence.CATEGORY: violence.analyze,
    kissing.CATEGORY: kissing.analyze,
    profanity.CATEGORY: profanity.analyze,
    lgbtq.CATEGORY: lgbtq.analyze,
}

ALLOWED_CATEGORIES: List[str] = list(CATEGORY_ANALYZERS.keys())

# CORS: chrome-extension://*, http://localhost:*, http://10.0.2.2:* — no wildcard *
CORS_ALLOW_ORIGIN_REGEX = (
    r"^(chrome-extension://.*|http://localhost:\d+|http://10\.0\.2\.2:\d+)$"
)


def _normalize_response(result: Dict[str, Any], category: str) -> Dict[str, Any]:
    """
    Ensure every /analyze-image response matches the API contract.

    Args:
        result: Raw dict from a category model module.
        category: Requested category string.

    Returns:
        dict: category, detected, confidence, action, model_loaded.
    """
    return {
        "category": result.get("category", category),
        "detected": bool(result.get("detected", False)),
        "confidence": float(result.get("confidence", 0.0)),
        "action": result.get("action", ACTION_ALLOW),
        "model_loaded": bool(
            result.get("model_loaded", model_loader.MODEL_LOADED)
        ),
    }


def _fail_open_response(category: str) -> Dict[str, Any]:
    """
    Build a fail-open response when frame processing or routing fails.

    Args:
        category: Requested detection category.

    Returns:
        dict: No detection; model_loaded reflects nudity weights status.
    """
    return {
        "category": category,
        "detected": False,
        "confidence": 0.0,
        "action": ACTION_ALLOW,
        "model_loaded": model_loader.MODEL_LOADED,
    }


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    Application lifespan: load dino_v3_linear.pth once before serving requests.
    """
    logging.basicConfig(level=logging.INFO)
    if not model_loader.MODEL_LOADED:
        model_loader.load_model()
    logger.info(
        "[SafeView] Backend ready — model_loaded=%s",
        model_loader.MODEL_LOADED,
    )
    yield


app = FastAPI(
    title="SafeView AI Backend",
    description="Shared content moderation API for browser extension and Android app.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> Dict[str, Any]:
    """
    Health check — reports server status and whether model weights are loaded.

    Returns:
        dict: { status, model, model_loaded } per API contract.
    """
    return {
        "status": "ok",
        "model": model_loader.MODEL_NAME,
        "model_loaded": model_loader.MODEL_LOADED,
    }


@app.post("/analyze-image")
async def analyze_image(
    frame: UploadFile = File(...),
    sensitivity: float = Form(...),
    category: str = Form(...),
) -> Dict[str, Any]:
    """
    Analyze a single JPEG frame for the requested content category.

    Request (multipart/form-data):
        frame: JPEG image bytes
        sensitivity: float 0.0–1.0
        category: nudity | violence | kissing | profanity | lgbtq

    Response:
        category, detected, confidence, action (BLUR | ALLOW), model_loaded

    Args:
        frame: Uploaded JPEG from extension or Android client.
        sensitivity: User sensitivity setting (BR-01 applied in inference for nudity).
        category: Detection category to run.

    Returns:
        dict: Analysis result per API contract.
    """
    category_normalized = category.strip().lower()

    if category_normalized not in CATEGORY_ANALYZERS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category '{category}'. Allowed: {', '.join(ALLOWED_CATEGORIES)}",
        )

    if not SENSITIVITY_MIN <= sensitivity <= SENSITIVITY_MAX:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Sensitivity must be between {SENSITIVITY_MIN} and {SENSITIVITY_MAX}, "
                f"got {sensitivity}."
            ),
        )

    analyze_fn = CATEGORY_ANALYZERS[category_normalized]
    image: Image.Image | None = None

    try:
        frame_bytes = await frame.read()
        if not frame_bytes:
            raise ValueError("Empty frame upload")

        image = Image.open(BytesIO(frame_bytes))
        result = analyze_fn(image, sensitivity)
        return _normalize_response(result, category_normalized)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "[SafeView] Failed to process frame for %s: %s",
            category_normalized,
            exc,
        )
        return _fail_open_response(category_normalized)
    finally:
        if image is not None:
            image.close()
