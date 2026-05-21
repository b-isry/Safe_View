// SafeView — options.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for options sensitivity mapping and settings helpers.

import {
  DEFAULT_SETTINGS,
  SENSITIVITY_HIGH,
  SENSITIVITY_LOW,
  SENSITIVITY_MEDIUM,
  effectiveThreshold,
} from "../src/background/businessRules";

describe("options sensitivity stops", () => {
  it("exposes Low/Medium/High values from master prompt", () => {
    expect(SENSITIVITY_LOW).toBe(0.6);
    expect(SENSITIVITY_MEDIUM).toBe(0.75);
    expect(SENSITIVITY_HIGH).toBe(0.9);
  });

  it("includes profanityWords in default settings", () => {
    expect(Array.isArray(DEFAULT_SETTINGS.profanityWords)).toBe(true);
  });

  it("applies BR-01 floor for Low sensitivity", () => {
    expect(effectiveThreshold(SENSITIVITY_LOW)).toBe(0.75);
  });
});
