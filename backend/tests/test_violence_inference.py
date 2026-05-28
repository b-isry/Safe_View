# SafeView — tests/test_violence_inference.py
# Purpose: Violence YOLO inference unit tests with mocked predict output.

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from PIL import Image

import violence_inference
import violence_loader


class _FakeBoxes:
    def __init__(self) -> None:
        import torch

        self.conf = torch.tensor([0.92, 0.05])
        self.cls = torch.tensor([0, 1])
        self.xyxy = torch.tensor(
            [
                [10.0, 20.0, 110.0, 120.0],
                [5.0, 5.0, 15.0, 15.0],
            ]
        )

    def __len__(self) -> int:
        return len(self.conf)


class _FakeResult:
    def __init__(self) -> None:
        self.names = {0: "fight", 1: "weapon", 2: "blood"}
        self.boxes = _FakeBoxes()


def test_run_detection_returns_normalized_boxes() -> None:
    """High-confidence fight box is returned; low-confidence weapon is filtered."""
    image = Image.new("RGB", (200, 200), (128, 128, 128))
    mock_model = MagicMock()
    mock_model.names = {0: "fight", 1: "weapon", 2: "blood"}
    mock_model.predict.return_value = [_FakeResult()]

    with patch.object(violence_loader, "get_model", return_value=mock_model), patch.object(
        violence_loader, "MODEL_LOADED", True
    ):
        result = violence_inference.run_detection(image, sensitivity=0.75)

    image.close()
    assert result["detected"] is True
    assert result["action"] == violence_inference.ACTION_BLUR
    assert result["label"] == "VIOLENCE"
    assert len(result["detections"]) == 1
    detection = result["detections"][0]
    assert detection["class"] == "fight"
    assert detection["confidence"] == pytest.approx(0.92)
    assert detection["box"] == [0.05, 0.1, 0.55, 0.6]


def test_run_detection_uses_low_yolo_conf() -> None:
    """YOLO predict uses a low conf so sub-0.5 violence.pt scores are not dropped early."""
    image = Image.new("RGB", (100, 100), (0, 0, 0))
    mock_model = MagicMock()
    mock_model.predict.return_value = []

    with patch.object(violence_loader, "get_model", return_value=mock_model), patch.object(
        violence_loader, "MODEL_LOADED", True
    ):
        violence_inference.run_detection(image, sensitivity=0.75)
        _args, kwargs = mock_model.predict.call_args
        assert kwargs["conf"] == violence_inference.YOLO_MIN_BOX_CONF

    image.close()
