# SafeView — violence_loader.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load last.pt (Ultralytics YOLO) once at import for violence detection.

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

MODEL_FILENAME = "last.pt"
MODEL_NAME = "violence_yolo"
VIOLENCE_CLASS_NAMES = ("fight", "weapon", "blood")

_model: Optional[Any] = None
MODEL_LOADED: bool = False


def get_model_path() -> Path:
    """Return the filesystem path for the violence YOLO weights."""
    return Path(__file__).resolve().parent / "models" / MODEL_FILENAME


def is_model_loaded() -> bool:
    """True when violence weights are cached in memory."""
    return MODEL_LOADED


def load_model() -> None:
    """
    Load last.pt into the module-level YOLO cache.

    On failure, logs and leaves MODEL_LOADED=False (fail open).
    """
    global _model, MODEL_LOADED

    weights_path = get_model_path()
    if not weights_path.is_file():
        logger.error(
            "[SafeView] %s not found at %s. Violence detection will fail open.",
            MODEL_FILENAME,
            weights_path,
        )
        _model = None
        MODEL_LOADED = False
        return

    try:
        from ultralytics import YOLO

        _model = YOLO(str(weights_path))
        MODEL_LOADED = True
        logger.info(
            "[SafeView] Loaded %s from %s (classes: %s).",
            MODEL_NAME,
            weights_path,
            ", ".join(VIOLENCE_CLASS_NAMES),
        )
    except Exception as exc:
        logger.error(
            "[SafeView] Failed to load %s from %s: %s. Violence detection will fail open.",
            MODEL_FILENAME,
            weights_path,
            exc,
        )
        _model = None
        MODEL_LOADED = False


def get_model() -> Optional[Any]:
    """Return the cached YOLO model, or None if loading failed."""
    return _model


load_model()
