// SafeView — options.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for options sensitivity mapping and settings helpers.

import {
  DEFAULT_SETTINGS,
  MAX_DETECTION_THRESHOLD,
  MIN_DETECTION_THRESHOLD,
  effectiveThreshold,
} from "../src/background/businessRules";

describe("options detection thresholds", () => {
  it("exposes slider bounds from 0.00 to 0.90", () => {
    expect(MIN_DETECTION_THRESHOLD).toBe(0);
    expect(MAX_DETECTION_THRESHOLD).toBe(0.9);
  });

  it("includes separate default thresholds and profanityWords", () => {
    expect(DEFAULT_SETTINGS.nuditySensitivity).toBe(0.75);
    expect(DEFAULT_SETTINGS.violenceSensitivity).toBe(0.75);
    expect(Array.isArray(DEFAULT_SETTINGS.profanityWords)).toBe(true);
  });

  it("clamps thresholds to UI bounds", () => {
    expect(effectiveThreshold(-1)).toBe(0);
    expect(effectiveThreshold(0.42)).toBe(0.42);
    expect(effectiveThreshold(1)).toBe(0.9);
  });
});
