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



CONFIDENCE_FLOOR = vision_service.VISION_THRESHOLD



IMAGE_SIZE = 224

IMAGENET_MEAN = (0.485, 0.456, 0.406)

IMAGENET_STD = (0.229, 0.224, 0.225)



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

    """

    rgb_image = pil_image.convert("RGB")

    tensor = _preprocess_transform(rgb_image).unsqueeze(0)

    return tensor.to(model_loader.get_device(), non_blocking=False)





def _purge_tensor(tensor: torch.Tensor) -> None:

    del tensor





def _confidence_from_logits(logits: torch.Tensor) -> float:

    if logits.shape[-1] == 2:

        score = logits[0, POSITIVE_CLASS_INDEX] - logits[0, NEGATIVE_CLASS_INDEX]

        return torch.sigmoid(score).item()



    return torch.sigmoid(logits.reshape(-1)[0]).item()





def run_inference(tensor: torch.Tensor, sensitivity: float) -> Dict[str, Any]:

    """

    Run the cached model forward pass and apply BR-01 detection threshold.



    Returns:

        dict: detected, confidence, action (BLUR | ALLOW), label, reason, animation_score.

    """

    model = model_loader.get_model()

    if model is None or not model_loader.MODEL_LOADED:

        _purge_tensor(tensor)

        return {

            "detected": False,

            "confidence": 0.0,

            "action": ACTION_ALLOW,

            "label": "SFW",

            "reason": "safe frame",

            "animation_score": 0.0,

        }



    effective_threshold = max(CONFIDENCE_FLOOR, sensitivity)

    detected = False

    confidence = 0.0

    action = ACTION_ALLOW

    label = "SFW"

    reason = "safe frame"

    animation_score = 0.0



    try:

        assert not model.training

        model.eval()



        forward_started = time.perf_counter()

        with torch.inference_mode():

            logits = model(tensor)

            confidence = _confidence_from_logits(logits)

            label = (

                "NSFW"

                if logits[0, POSITIVE_CLASS_INDEX].item()

                > logits[0, NEGATIVE_CLASS_INDEX].item()

                else "SFW"

            )

            detected = confidence >= effective_threshold

            action = ACTION_BLUR if detected else ACTION_ALLOW

            reason = "nudity detected" if detected else "safe frame"

            del logits

        forward_ms = (time.perf_counter() - forward_started) * 1000.0



        logger.info(

            "[SafeView][Nudity] score=%.3f threshold=%.3f detected=%s",

            confidence,

            effective_threshold,

            detected,

        )

        if forward_ms > 200.0:

            logger.info(

                "[SafeView][Latency] inference=%.1fms (>200 ms on %s)",

                forward_ms,

                model_loader.get_device(),

            )

    except Exception as exc:

        logger.error("[SafeView] Inference failed: %s", exc)

        detected = False

        confidence = 0.0

        action = ACTION_ALLOW

        label = "SFW"

        reason = "safe frame"

    finally:

        _purge_tensor(tensor)



    return {

        "detected": detected,

        "confidence": confidence,

        "action": action,

        "label": label,

        "reason": reason,

        "animation_score": animation_score,

    }





def analyze_frame(pil_image: Image.Image, sensitivity: float) -> Dict[str, Any]:

    """

    Preprocess and run inference; log end-to-end timing for one frame.

    """

    total_started = time.perf_counter()

    preprocess_started = time.perf_counter()

    tensor = preprocess(pil_image)

    preprocess_ms = (time.perf_counter() - preprocess_started) * 1000.0



    result = run_inference(tensor, sensitivity)

    total_ms = (time.perf_counter() - total_started) * 1000.0

    inference_ms = max(0.0, total_ms - preprocess_ms)



    logger.info(

        "[SafeView][Latency] preprocess=%.1fms inference=%.1fms total=%.1fms",

        preprocess_ms,

        inference_ms,

        total_ms,

    )

    if total_ms > 700.0:

        logger.warning(

            "[SafeView][Performance] backend slow — consider CUDA or smaller model (total=%.1fms)",

            total_ms,

        )



    return result

