# SafeView — romance_loader.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load romance_classifier_final.keras once at import for kissing detection.

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

MODEL_FILENAME = "romance_classifier_final.keras"
MODEL_NAME = "romance_mobilenetv2"
INPUT_SIZE = 224

_model: Optional[Any] = None
MODEL_LOADED: bool = False


def get_model_path() -> Path:
    """Return the filesystem path for the romance Keras weights."""
    return Path(__file__).resolve().parent / "models" / MODEL_FILENAME


def is_model_loaded() -> bool:
    """True when romance weights are cached in memory."""
    return MODEL_LOADED


def load_model() -> None:
    """
    Load romance_classifier_final.keras into the module-level cache.

    On failure, logs and leaves MODEL_LOADED=False (fail open).
    """
    global _model, MODEL_LOADED

    weights_path = get_model_path()
    if not weights_path.is_file():
        logger.error(
            "[SafeView] %s not found at %s. Kissing detection will fail open.",
            MODEL_FILENAME,
            weights_path,
        )
        _model = None
        MODEL_LOADED = False
        return

    try:
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        import tensorflow as tf

        _model = tf.keras.models.load_model(str(weights_path))
        MODEL_LOADED = True
        logger.info(
            "[SafeView] Loaded %s from %s (input=%sx%s RGB, sigmoid romance score).",
            MODEL_NAME,
            weights_path,
            INPUT_SIZE,
            INPUT_SIZE,
        )
    except Exception as exc:
        logger.error(
            "[SafeView] Failed to load %s from %s: %s. Kissing detection will fail open.",
            MODEL_FILENAME,
            weights_path,
            exc,
        )
        _model = None
        MODEL_LOADED = False


def get_model() -> Optional[Any]:
    """Return the cached Keras model, or None if loading failed."""
    return _model


load_model()
