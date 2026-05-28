# SafeView — violence_loader.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load violence.pt (Ultralytics YOLO) once at import for violence detection.

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

import paths

logger = logging.getLogger(__name__)

MODEL_FILENAME = paths.VIOLENCE_MODEL_PATH.name
MODEL_NAME = "violence_yolo"
VIOLENCE_MODEL_PATH = paths.VIOLENCE_MODEL_PATH
VIOLENCE_CLASS_NAMES = ("fight", "weapon", "blood")

_model: Optional[Any] = None
MODEL_LOADED: bool = False
_loaded_path: Optional[Path] = None


def resolve_weights_path() -> Optional[Path]:
    """Return the canonical violence.pt weights path when present."""
    if VIOLENCE_MODEL_PATH.is_file():
        return VIOLENCE_MODEL_PATH
    return None


def get_model_path() -> Path:
    """Return the resolved weights path (may not exist)."""
    resolved = resolve_weights_path()
    return resolved if resolved is not None else VIOLENCE_MODEL_PATH


def is_model_loaded() -> bool:
    """True when violence weights are cached in memory."""
    return MODEL_LOADED


def load_model() -> None:
    """
    Load violence.pt into the module-level YOLO cache.

    On failure, logs and leaves MODEL_LOADED=False (fail open).
    """
    global _model, MODEL_LOADED, _loaded_path

    weights_path = resolve_weights_path()
    if weights_path is None:
        logger.error(
            "[SafeView] %s not found at %s. Violence detection will fail open.",
            MODEL_FILENAME,
            VIOLENCE_MODEL_PATH,
        )
        _model = None
        MODEL_LOADED = False
        _loaded_path = None
        return

    try:
        from ultralytics import YOLO

        _model = YOLO(str(weights_path))
        MODEL_LOADED = True
        _loaded_path = weights_path
        logger.info(
            "[SafeView] Loaded %s from %s (classes: %s).",
            MODEL_NAME,
            weights_path,
            ", ".join(VIOLENCE_CLASS_NAMES),
        )
    except Exception as exc:
        logger.error(
            "[SafeView] Failed to load violence weights from %s: %s. Violence detection will fail open.",
            weights_path,
            exc,
        )
        _model = None
        MODEL_LOADED = False
        _loaded_path = None


def get_model() -> Optional[Any]:
    """Return the cached YOLO model, or None if loading failed."""
    return _model


def get_loaded_path() -> Optional[Path]:
    """Return the path used for the loaded weights, if any."""
    return _loaded_path


load_model()
