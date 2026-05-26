# SafeView — vision_service.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Vision moderation labels and nudity threshold (Class 2 only).

from __future__ import annotations

# Targeted nudity class from industrial calibration — classes 0/1 ignored.
SAFEVIEW_LABELS = {2: "Nudity", "2": "Nudity"}
NUDITY_CLASS_ID = 2

# High precision threshold — clothed people should not trigger (100% precision goal).
VISION_THRESHOLD = 0.90
