# SafeView — vision_service.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Vision moderation threshold for nudity / content blur detection.

from __future__ import annotations

# Minimum confidence to trigger BLUR (scores like 0.51 should pass).
VISION_THRESHOLD = 0.45
