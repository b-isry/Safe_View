# SafeView — main.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: FastAPI application entry point — CORS, routes, and startup model loading.

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, List

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field

import audio_processor
import model_loader
import romance_loader
import violence_loader
from models import kissing, lgbtq, nudity, profanity, violence

logger = logging.getLogger(__name__)

DEBUG_LOG_PATH = Path(__file__).resolve().parent.parent / "debug-42ea0a.log"


def _agent_log(
    hypothesis_id: str,
    location: str,
    message: str,
    data: Dict[str, Any] | None = None,
) -> None:
    # #region agent log
    try:
        entry = {
            "sessionId": "42ea0a",
            "timestamp": int(time.time() * 1000),
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data or {},
        }
        with DEBUG_LOG_PATH.open("a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(entry) + "\n")
    except OSError:
        pass
    # #endregion


class AgentLogPayload(BaseModel):
    """Client-side debug log relay for Android instrumentation."""

    hypothesisId: str
    location: str
    message: str
    data: Dict[str, Any] = Field(default_factory=dict)


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
ALLOWED_AUDIO_LANGUAGES: List[str] = ["en", "am"]

ANALYZE_AUDIO_RESPONSE_KEYS = {
    "category",
    "detected",
    "action",
    "duration_ms",
    "whisper_loaded",
    "confidence",
}

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
    raw_label = result.get("label", "SFW")
    label = raw_label if raw_label in ("NSFW", "SFW") else "SFW"

    normalized: Dict[str, Any] = {
        "category": result.get("category", category),
        "detected": bool(result.get("detected", False)),
        "confidence": float(result.get("confidence", 0.0)),
        "action": result.get("action", ACTION_ALLOW),
        "label": label,
        "model_loaded": bool(
            result.get(
                "model_loaded",
                _category_model_loaded(category),
            )
        ),
    }

    gate_reason = result.get("gate_reason")
    if isinstance(gate_reason, str):
        normalized["gate_reason"] = gate_reason

    content_type = result.get("content_type")
    if isinstance(content_type, dict):
        normalized["content_type"] = content_type

    return normalized


def _category_model_loaded(category: str) -> bool:
    """Return whether weights for the requested category are loaded."""
    if category == violence.CATEGORY:
        return violence_loader.MODEL_LOADED
    if category == kissing.CATEGORY:
        return romance_loader.MODEL_LOADED
    if category == nudity.CATEGORY:
        return model_loader.MODEL_LOADED
    return False


def _fail_open_response(category: str) -> Dict[str, Any]:
    """
    Build a fail-open response when frame processing or routing fails.

    Args:
        category: Requested detection category.

    Returns:
        dict: No detection; model_loaded reflects category weights status.
    """
    return {
        "category": category,
        "detected": False,
        "confidence": 0.0,
        "action": ACTION_ALLOW,
        "label": "SFW",
        "model_loaded": _category_model_loaded(category),
    }


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    Application lifespan: load dino_v3_linear.pth once before serving requests.
    """
    logging.basicConfig(level=logging.INFO)
    if not model_loader.MODEL_LOADED:
        model_loader.load_model()
    if not violence_loader.MODEL_LOADED:
        violence_loader.load_model()
    if not romance_loader.MODEL_LOADED:
        romance_loader.load_model()
    logger.info(
        "[SafeView] Backend ready — nudity_loaded=%s violence_loaded=%s kissing_loaded=%s whisper_loaded=%s",
        model_loader.MODEL_LOADED,
        violence_loader.MODEL_LOADED,
        romance_loader.MODEL_LOADED,
        audio_processor.WHISPER_LOADED,
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


@app.post("/internal/debug-ingest")
async def debug_ingest(payload: AgentLogPayload) -> Dict[str, str]:
    """Relay Android client debug logs to the session NDJSON file."""
    _agent_log(payload.hypothesisId, payload.location, payload.message, payload.data)
    return {"status": "ok"}


@app.get("/health")
async def health() -> Dict[str, Any]:
    """
    Health check — reports server status and whether model weights are loaded.

    Returns:
        dict: { status, model, model_loaded, whisper_loaded } per API contract.
    """
    return {
        "status": "ok",
        "model": model_loader.MODEL_NAME,
        "model_loaded": model_loader.MODEL_LOADED,
        "whisper_loaded": audio_processor.WHISPER_LOADED,
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

        # #region agent log
        _agent_log(
            "H1",
            "main.py:analyze_image:entry",
            "analyze-image request received",
            {
                "category": category_normalized,
                "sensitivity": sensitivity,
                "frameBytes": len(frame_bytes),
            },
        )
        # #endregion

        image = Image.open(BytesIO(frame_bytes))
        inference_started = time.perf_counter()
        result = await asyncio.to_thread(analyze_fn, image, sensitivity)
        inference_ms = (time.perf_counter() - inference_started) * 1000.0
        logger.info(
            "[SafeView][Latency] analyze-image category=%s inference=%.1fms",
            category_normalized,
            inference_ms,
        )
        normalized = _normalize_response(result, category_normalized)
        # #region agent log
        _agent_log(
            "H2",
            "main.py:analyze_image:exit",
            "analyze-image response",
            {
                "category": category_normalized,
                "action": normalized.get("action"),
                "detected": normalized.get("detected"),
                "confidence": normalized.get("confidence"),
                "gate_reason": normalized.get("gate_reason"),
                "content_type": normalized.get("content_type"),
                "inferenceMs": round(inference_ms, 1),
            },
        )
        # #endregion
        return normalized
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


@app.post("/analyze-audio")
async def analyze_audio(
    audio_chunk: UploadFile = File(...),
    language: str = Form(...),
    sensitivity: float = Form(...),
) -> Dict[str, Any]:
    """
    Transcribe a WebM audio chunk and detect profanity (BR-05 mute duration).

    Request (multipart/form-data):
        audio_chunk: WebM/Opus bytes from MediaRecorder
        language: en | am
        sensitivity: float 0.0–1.0 (unused for profanity; kept for API consistency)

    Response:
        detected, action (MUTE | ALLOW), duration_ms (always 1500), whisper_loaded

    Args:
        audio_chunk: Uploaded audio from extension or Android client.
        language: Whisper transcription language code.
        sensitivity: User sensitivity (accepted but not applied to profanity).

    Returns:
        dict: Profanity analysis result per API contract.
    """
    language_normalized = language.strip().lower()

    if language_normalized not in ALLOWED_AUDIO_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid language '{language}'. "
                f"Allowed: {', '.join(ALLOWED_AUDIO_LANGUAGES)}"
            ),
        )

    if not SENSITIVITY_MIN <= sensitivity <= SENSITIVITY_MAX:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Sensitivity must be between {SENSITIVITY_MIN} and {SENSITIVITY_MAX}, "
                f"got {sensitivity}."
            ),
        )

    try:
        audio_bytes = await audio_chunk.read()
        return profanity.analyze_audio(
            audio_bytes,
            language_normalized,
            sensitivity,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[SafeView] Failed to process audio chunk: %s", exc)
        return {
            "detected": False,
            "action": ACTION_ALLOW,
            "duration_ms": profanity.MUTE_DURATION_MS,
            "whisper_loaded": audio_processor.WHISPER_LOADED,
        }
