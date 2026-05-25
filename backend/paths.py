# SafeView — paths.py
# Purpose: Stable absolute paths for model weights.

from __future__ import annotations

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"

NUDITY_MODEL_PATH = MODELS_DIR / "dino_v3_linear.pth"
DINOV3_CONFIG_DIR = MODELS_DIR / "dinov3-vits16-pretrain-lvd1689m"
VIOLENCE_MODEL_PATH = MODELS_DIR / "violence.pt"
VIOLENCE_MODEL_FALLBACK_PATH = MODELS_DIR / "last.pt"
