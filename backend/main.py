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

import api_schema
import audio_processor
import model_loader
import paths
import violence_loader
from models import nudity, violence

logger = logging.getLogger(__name__)

DEBUG_LOG_PATH = Path(__file__).resolve().parent.parent / "debug-42ea0a.log"

ALLOWED_CATEGORIES: List[str] = ["nudity", "violence", "all"]
ALLOWED_AUDIO_LANGUAGES: List[str] = ["en", "am"]

AnalyzeFn = Callable[[Image.Image, float], Dict[str, Any]]

CATEGORY_ANALYZERS: Dict[str, AnalyzeFn] = {
    nudity.CATEGORY: nudity.analyze,
    violence.CATEGORY: violence.analyze,
}

ANALYZE_AUDIO_RESPONSE_KEYS = {
    "category",
    "detected",
    "action",
    "duration_ms",
    "whisper_loaded",
    "confidence",
}

# CORS: chrome-extension://*, localhost, 127.0.0.1, Android emulator
CORS_ALLOW_ORIGIN_REGEX = (
    r"^(chrome-extension://.*|http://localhost:\d+|http://127\.0\.0\.1:\d+|http://10\.0\.2\.2:\d+)$"
)


class AgentLogPayload(BaseModel):
    """Client-side debug log relay for Android instrumentation."""

    hypothesisId: str
    location: str
    message: str
    data: Dict[str, Any] = Field(default_factory=dict)


def _agent_log(
    hypothesis_id: str,
    location: str,
    message: str,
    data: Dict[str, Any] | None = None,
) -> None:
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


def _model_health_entry(
    *,
    loaded: bool,
    path: Path,
    model_type: str,
    supports_boxes: bool,
    error: str | None = None,
) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "loaded": loaded,
        "path": str(path),
        "type": model_type,
        "supports_boxes": supports_boxes,
    }
    if error:
        entry["error"] = error
    return entry


def _build_health_models() -> Dict[str, Any]:
    nudity_path = paths.NUDITY_MODEL_PATH
    violence_path = violence_loader.get_loaded_path() or paths.VIOLENCE_MODEL_PATH

    nudity_error = None
    if not model_loader.MODEL_LOADED:
        if not nudity_path.is_file():
            nudity_error = f"{nudity_path.name} not found at {nudity_path}"
        elif model_loader.LAST_LOAD_ERROR:
            nudity_error = model_loader.LAST_LOAD_ERROR
        else:
            nudity_error = f"{nudity_path.name} failed to load — see server logs"

    violence_error = None
    if not violence_loader.MODEL_LOADED:
        resolved = violence_loader.resolve_weights_path()
        if resolved is None:
            violence_error = (
                f"{paths.VIOLENCE_MODEL_PATH.name} not found "
                f"(fallback {paths.VIOLENCE_MODEL_FALLBACK_PATH.name} also missing)"
            )
        else:
            violence_error = "violence weights failed to load — see server logs"

    return {
        "nudity": _model_health_entry(
            loaded=model_loader.MODEL_LOADED,
            path=nudity_path,
            model_type="dino_classifier",
            supports_boxes=False,
            error=nudity_error,
        ),
        "violence": _model_health_entry(
            loaded=violence_loader.MODEL_LOADED,
            path=violence_path,
            model_type="yolo_detector",
            supports_boxes=True,
            error=violence_error,
        ),
    }


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load nudity and violence models once before serving requests."""
    logging.basicConfig(level=logging.INFO)
    model_loader.load_model()
    if not violence_loader.MODEL_LOADED:
        violence_loader.load_model()
    logger.info(
        "[SafeView] Backend ready — nudity_loaded=%s violence_loaded=%s whisper_loaded=%s",
        model_loader.MODEL_LOADED,
        violence_loader.MODEL_LOADED,
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
    allow_methods=["*"],
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
    Health check — server status and per-model load state.

    Returns:
        status, backend, models{nudity, violence}, legacy model_loaded for clients.
    """
    models = _build_health_models()
    return {
        "status": "ok",
        "backend": "running",
        "models": models,
        # Legacy fields for older extension/Android clients
        "model": model_loader.MODEL_NAME,
        "model_loaded": model_loader.MODEL_LOADED,
        "whisper_loaded": audio_processor.WHISPER_LOADED,
    }


@app.post("/analyze-image")
async def analyze_image(
    frame: UploadFile = File(...),
    sensitivity: float = Form(0.75),
    category: str = Form("nudity"),
) -> Dict[str, Any]:
    """
    Analyze a single JPEG frame for nudity and/or violence.

    Categories: nudity | violence | all
    """
    category_normalized = category.strip().lower() or "nudity"

    if category_normalized not in ALLOWED_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category '{category}'. Allowed: {', '.join(ALLOWED_CATEGORIES)}",
        )

    if not 0.0 <= sensitivity <= 1.0:
        raise HTTPException(
            status_code=400,
            detail=f"Sensitivity must be between 0.0 and 1.0, got {sensitivity}.",
        )

    image: Image.Image | None = None

    try:
        frame_bytes = await frame.read()
        if not frame_bytes:
            raise ValueError("Empty frame upload")

        image = Image.open(BytesIO(frame_bytes))

        if category_normalized == "all":
            nudity_result = await asyncio.to_thread(
                nudity.analyze, image, sensitivity
            )
            violence_result = await asyncio.to_thread(
                violence.analyze, image, sensitivity
            )
            merged = api_schema.merge_category_results(nudity_result, violence_result)
            return merged

        analyze_fn = CATEGORY_ANALYZERS[category_normalized]
        inference_started = time.perf_counter()
        result = await asyncio.to_thread(analyze_fn, image, sensitivity)
        inference_ms = (time.perf_counter() - inference_started) * 1000.0
        logger.info(
            "[SafeView][Latency] analyze-image category=%s inference=%.1fms",
            category_normalized,
            inference_ms,
        )
        return api_schema.normalize_analyze_response(result, category_normalized)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "[SafeView] Failed to process frame for %s: %s",
            category_normalized,
            exc,
        )
        return api_schema.build_fail_open(category_normalized)
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
    Transcribe a WebM audio chunk and detect profanity (optional; extension may disable).
    """
    from models import profanity

    language_normalized = language.strip().lower()

    if language_normalized not in ALLOWED_AUDIO_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid language '{language}'. "
                f"Allowed: {', '.join(ALLOWED_AUDIO_LANGUAGES)}"
            ),
        )

    if not 0.0 <= sensitivity <= 1.0:
        raise HTTPException(
            status_code=400,
            detail=f"Sensitivity must be between 0.0 and 1.0, got {sensitivity}.",
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
            "action": "ALLOW",
            "duration_ms": profanity.MUTE_DURATION_MS,
            "whisper_loaded": audio_processor.WHISPER_LOADED,
        }
