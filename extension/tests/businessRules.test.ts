// SafeView — businessRules.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for sensitivity handling in the extension.

import {
  DEFAULT_SETTINGS,
  effectiveThreshold,
  getEnabledCategories,
  shouldBlur,
} from "../src/background/businessRules";

describe("businessRules sensitivity", () => {
  it("uses UI sensitivity directly as the effective threshold", () => {
    expect(effectiveThreshold(0.1)).toBe(0.1);
    expect(effectiveThreshold(0.75)).toBe(0.75);
    expect(effectiveThreshold(0.9)).toBe(0.9);
  });

  it("clamps sensitivity to the valid confidence range", () => {
    expect(effectiveThreshold(-1)).toBe(0);
    expect(effectiveThreshold(2)).toBe(0.9);
  });

  it("uses low UI sensitivity without a hardcoded floor", () => {
    expect(shouldBlur(0.09, 0.1)).toBe(false);
    expect(shouldBlur(0.1, 0.1)).toBe(true);
  });

  it("uses high UI sensitivity as configured", () => {
    expect(shouldBlur(0.89, 0.9)).toBe(false);
    expect(shouldBlur(0.9, 0.9)).toBe(true);
  });

  it("uses medium UI sensitivity as configured", () => {
    expect(effectiveThreshold(0.75)).toBe(0.75);
    expect(shouldBlur(0.74, 0.75)).toBe(false);
    expect(shouldBlur(0.75, 0.75)).toBe(true);
  });

  it("respects nudity toggle when protection is on", () => {
    const settingsOn = {
      ...DEFAULT_SETTINGS,
      protectionEnabled: true,
      categories: { ...DEFAULT_SETTINGS.categories, nudity: true, violence: false },
    };
    const settingsOff = {
      ...DEFAULT_SETTINGS,
      protectionEnabled: true,
      categories: {
        ...DEFAULT_SETTINGS.categories,
        nudity: false,
        violence: false,
        kissing: false,
        profanity: false,
      },
    };
    expect(getEnabledCategories(settingsOn)).toEqual(["nudity"]);
    expect(getEnabledCategories(settingsOff)).toEqual([]);
  });

  it("returns no categories when protection is off", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      protectionEnabled: false,
    };
    expect(getEnabledCategories(settings)).toEqual([]);
  });
});
