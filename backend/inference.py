# SafeView — inference.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Image preprocessing, forward pass, and BR-01 threshold application for nudity detection.

from __future__ import annotations

import logging
import time
from typing import Any, Dict

import torch
from PIL import Image
from torchvision import transforms

import model_loader
import vision_service

logger = logging.getLogger(__name__)

# BR-01: nudity floor — Class 2 only, 0.90 minimum (vision_service).
CONFIDENCE_FLOOR = vision_service.VISION_THRESHOLD
NUDITY_CLASS_ID = vision_service.NUDITY_CLASS_ID

IMAGE_SIZE = 224
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)

# Index of the positive (nudity) logit in the 2-class linear head
POSITIVE_CLASS_INDEX = 1
NEGATIVE_CLASS_INDEX = 0

ACTION_BLUR = "BLUR"
ACTION_ALLOW = "ALLOW"

_preprocess_transform = transforms.Compose(
    [
        transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ]
)


def preprocess(pil_image: Image.Image) -> torch.Tensor:
    """
    Convert a PIL image into a batched, normalized tensor on the model device.

    Steps:
        1. Resize to 224x224
        2. Convert to RGB if not already
        3. ToTensor()
        4. Normalize with ImageNet mean/std
        5. Add batch dimension via unsqueeze(0)
        6. Move to model device

    Args:
        pil_image: Decoded frame from the client upload.

    Returns:
        torch.Tensor: Single-batch input tensor (1x3x224x224) on the inference device.
    """
    rgb_image = pil_image.convert("RGB")
    tensor = _preprocess_transform(rgb_image).unsqueeze(0)
    return tensor.to(model_loader.get_device(), non_blocking=False)


def _purge_tensor(tensor: torch.Tensor) -> None:
    """
    Release tensor memory per BR-02 (purge frame data after analysis).

    Args:
        tensor: Tensor to delete from memory.
    """
    del tensor


def _confidence_from_logits(logits: torch.Tensor) -> float:
    """
    Map model logits to P(nudity) for the loaded head.

    Multi-class heads: only SAFEVIEW Class 2 (Nudity). Binary heads: legacy sigmoid pair.

    Args:
        logits: Raw model output (1, C).

    Returns:
        float: Nudity probability in [0.0, 1.0].
    """
    num_classes = int(logits.shape[-1])

    if num_classes > NUDITY_CLASS_ID:
        probs = torch.softmax(logits[0], dim=-1)
        return probs[NUDITY_CLASS_ID].item()

    if num_classes == 2:
        score = logits[0, POSITIVE_CLASS_INDEX] - logits[0, NEGATIVE_CLASS_INDEX]
        return torch.sigmoid(score).item()

    return torch.sigmoid(logits.reshape(-1)[0]).item()


def _label_from_logits(logits: torch.Tensor) -> str:
    """Return NSFW only when Class 2 is the restricted nudity label."""
    num_classes = int(logits.shape[-1])
    if num_classes > NUDITY_CLASS_ID:
        class_id = int(torch.argmax(logits[0], dim=-1).item())
        if class_id == NUDITY_CLASS_ID:
            return "NSFW"
        return "SFW"

    if logits[0, POSITIVE_CLASS_INDEX].item() > logits[0, NEGATIVE_CLASS_INDEX].item():
        return "NSFW"
    return "SFW"


def run_inference_raw(tensor: torch.Tensor) -> Dict[str, Any]:
    """
    Run forward pass and return raw nudity score (no sensitivity threshold).

    Returns:
        dict: confidence (P nudity), label (NSFW|SFW).
    """
    model = model_loader.get_model()
    if model is None or not model_loader.MODEL_LOADED:
        _purge_tensor(tensor)
        return {
            "confidence": 0.0,
            "label": "SFW",
        }

    confidence = 0.0
    label = "SFW"

    try:
        assert not model.training
        model.eval()

        with torch.inference_mode():
            logits = model(tensor)
            confidence = _confidence_from_logits(logits)
            label = _label_from_logits(logits)
            del logits
    except Exception as exc:
        logger.error("[SafeView] Inference failed: %s", exc)
    finally:
        _purge_tensor(tensor)

    return {
        "confidence": confidence,
        "label": label,
    }


def run_inference(tensor: torch.Tensor, sensitivity: float) -> Dict[str, Any]:
    """
    Run the cached model forward pass and apply BR-01 detection threshold.

    Args:
        tensor: Preprocessed input from preprocess().
        sensitivity: User sensitivity in range 0.0–1.0.

    Returns:
        dict: detected (bool), confidence (float), action (BLUR | ALLOW).
    """
    model = model_loader.get_model()
    if model is None or not model_loader.MODEL_LOADED:
        _purge_tensor(tensor)
        return {
            "detected": False,
            "confidence": 0.0,
            "action": ACTION_ALLOW,
            "label": "SFW",
        }

    effective_threshold = max(CONFIDENCE_FLOOR, sensitivity)
    detected = False
    confidence = 0.0
    action = ACTION_ALLOW
    label = "SFW"

    try:
        assert not model.training
        model.eval()

        forward_started = time.perf_counter()
        with torch.inference_mode():
            logits = model(tensor)
            confidence = _confidence_from_logits(logits)
            label = _label_from_logits(logits)
            detected = confidence >= effective_threshold and label == "NSFW"
            action = ACTION_BLUR if detected else ACTION_ALLOW
            del logits
        forward_ms = (time.perf_counter() - forward_started) * 1000.0
        if forward_ms > 200.0:
            logger.info(
                "[SafeView] Forward pass %.1f ms (>200 ms on %s). "
                "For lower latency use CUDA, or try torch.compile / FP16 on GPU.",
                forward_ms,
                model_loader.get_device(),
            )
        else:
            logger.debug("[SafeView] Forward pass %.1f ms", forward_ms)

        if 0.65 <= confidence < effective_threshold:
            logger.debug(
                "[SafeView] Borderline nudity score %.3f (threshold %.3f)",
                confidence,
                effective_threshold,
            )
    except Exception as exc:
        logger.error("[SafeView] Inference failed: %s", exc)
        detected = False
        confidence = 0.0
        action = ACTION_ALLOW
        label = "SFW"
    finally:
        _purge_tensor(tensor)

    return {
        "detected": detected,
        "confidence": confidence,
        "action": action,
        "label": label,
    }
