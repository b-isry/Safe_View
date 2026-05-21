# SafeView — model_loader.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load dino_v3_linear.pth once at import and expose the cached nudity classifier.

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Optional, Union

import torch
import torch.nn as nn
from transformers import AutoConfig, AutoModel, PreTrainedModel

logger = logging.getLogger(__name__)

MODEL_FILENAME = "dino_v3_linear.pth"
MODEL_NAME = "dino_v3_linear"
DINOV3_CONFIG_ID = "facebook/dinov3-vits16-pretrain-lvd1689m"
HEAD_IN_FEATURES = 384
HEAD_OUT_FEATURES = 2
BACKBONE_STATE_PREFIX = "backbone."
MODEL_WRAPPER_PREFIX = "model."

_model: Optional["NudityDetectionModel"] = None
MODEL_LOADED: bool = False
_device: torch.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


class NudityDetectionModel(nn.Module):
    """
    DINOv3 ViT-S/16 backbone with a linear classification head from dino_v3_linear.pth.

    Forward pass returns raw logits for the 2-class head (inference applies sigmoid/threshold).
    """

    def __init__(self, backbone: PreTrainedModel, head: nn.Linear) -> None:
        """
        Wire backbone and head into a single eval-ready module.

        Args:
            backbone: Hugging Face DINOv3 encoder matching the checkpoint architecture.
            head: Linear layer loaded from head.weight / head.bias in the checkpoint.
        """
        super().__init__()
        self.backbone = backbone
        self.head = head

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        """
        Run backbone on a batch of normalized images and return classification logits.

        Args:
            pixel_values: BCHW tensor (typically 1x3x224x224) on the inference device.

        Returns:
            torch.Tensor: Logits of shape (batch, HEAD_OUT_FEATURES).
        """
        outputs = self.backbone(pixel_values=pixel_values)
        cls_token = outputs.last_hidden_state[:, 0]
        return self.head(cls_token)


def get_model_path() -> Path:
    """
    Return the filesystem path for the team-provided weights file.

    Expected location: backend/models/dino_v3_linear.pth

    Returns:
        Path: Absolute path to dino_v3_linear.pth.
    """
    return Path(__file__).resolve().parent / "models" / MODEL_FILENAME


def get_device() -> torch.device:
    """
    Return the torch device used for inference (CPU or CUDA when available).

    Returns:
        torch.device: Active inference device.
    """
    return _device


def is_model_loaded() -> bool:
    """
    Indicate whether weights were successfully loaded at startup.

    Returns:
        bool: True if the model is cached in memory; False otherwise.
    """
    return MODEL_LOADED


def _split_checkpoint(
    checkpoint: Union[Dict[str, torch.Tensor], torch.Tensor, nn.Module, Any],
) -> tuple[Dict[str, torch.Tensor], Dict[str, torch.Tensor]]:
    """
    Separate backbone and head tensors from a torch.load() result.

    Args:
        checkpoint: Object returned by torch.load() for dino_v3_linear.pth.

    Returns:
        tuple: (backbone_state_dict, head_state_dict) with backbone. prefix stripped.

    Raises:
        ValueError: If the checkpoint does not contain the expected keys.
    """
    if not isinstance(checkpoint, dict):
        raise ValueError(
            f"Expected state dict in {MODEL_FILENAME}, got {type(checkpoint).__name__}"
        )

    backbone_state: Dict[str, torch.Tensor] = {}
    head_state: Dict[str, torch.Tensor] = {}

    for key, value in checkpoint.items():
        if key.startswith(BACKBONE_STATE_PREFIX):
            stripped_key = key[len(BACKBONE_STATE_PREFIX) :]
            if stripped_key.startswith(MODEL_WRAPPER_PREFIX):
                stripped_key = stripped_key[len(MODEL_WRAPPER_PREFIX) :]
            backbone_state[stripped_key] = value
        elif key.startswith("head."):
            head_state[key] = value

    if not backbone_state:
        raise ValueError(f"No '{BACKBONE_STATE_PREFIX}' keys found in {MODEL_FILENAME}")
    if "head.weight" not in head_state or "head.bias" not in head_state:
        raise ValueError(f"Missing head.weight/head.bias in {MODEL_FILENAME}")

    return backbone_state, head_state


def _build_model_from_checkpoint(
    checkpoint: Dict[str, torch.Tensor],
    device: torch.device,
) -> NudityDetectionModel:
    """
    Instantiate backbone + head and load weights from the checkpoint state dict.

    Args:
        checkpoint: Full state dict from dino_v3_linear.pth.
        device: Target device for the assembled model.

    Returns:
        NudityDetectionModel: Model in eval mode on the given device.
    """
    backbone_state, head_state = _split_checkpoint(checkpoint)

    config = AutoConfig.from_pretrained(DINOV3_CONFIG_ID)
    backbone = AutoModel.from_config(config)
    backbone.load_state_dict(backbone_state, strict=True)

    head = nn.Linear(HEAD_IN_FEATURES, HEAD_OUT_FEATURES)
    head.load_state_dict(
        {
            "weight": head_state["head.weight"],
            "bias": head_state["head.bias"],
        },
        strict=True,
    )

    model = NudityDetectionModel(backbone=backbone, head=head)
    model.to(device)
    model.eval()
    return model


def load_model() -> None:
    """
    Load dino_v3_linear.pth once into the module-level cache.

    On success, sets _model and MODEL_LOADED=True. On missing file or load error,
    logs a clear message, leaves _model=None, and sets MODEL_LOADED=False (fail open).
    """
    global _model, MODEL_LOADED, _device

    weights_path = get_model_path()
    _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    if not weights_path.is_file():
        logger.error(
            "[SafeView] %s not found at %s. "
            "Place the team weights at backend/models/%s. Nudity detection will fail open.",
            MODEL_FILENAME,
            weights_path,
            MODEL_FILENAME,
        )
        _model = None
        MODEL_LOADED = False
        return

    try:
        checkpoint = torch.load(weights_path, map_location="cpu", weights_only=False)
        _model = _build_model_from_checkpoint(checkpoint, _device)
        MODEL_LOADED = True
        logger.info(
            "[SafeView] Loaded %s from %s on device %s.",
            MODEL_NAME,
            weights_path,
            _device,
        )
    except Exception as exc:
        logger.error(
            "[SafeView] Failed to load %s from %s: %s. Nudity detection will fail open.",
            MODEL_FILENAME,
            weights_path,
            exc,
        )
        _model = None
        MODEL_LOADED = False


def get_model() -> Optional[NudityDetectionModel]:
    """
    Return the cached PyTorch model instance, or None if loading failed.

    Returns:
        Optional[NudityDetectionModel]: Model ready for eval(), or None.
    """
    return _model


load_model()
