// SafeView — businessRules.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for BR-01 threshold floor in the extension.

import {
  CONFIDENCE_FLOOR,
  DEFAULT_SETTINGS,
  effectiveThreshold,
  getEnabledCategories,
  shouldBlur,
} from "../src/background/businessRules";

describe("businessRules BR-01", () => {
  it("sensitivity=0.1 still results in effective_threshold=0.75", () => {
    expect(effectiveThreshold(0.1)).toBe(0.75);
    expect(effectiveThreshold(0.1)).toBe(CONFIDENCE_FLOOR);
  });

  it("does not blur at 0.74 confidence when sensitivity is 0.1", () => {
    expect(shouldBlur(0.74, 0.1)).toBe(false);
  });

  it("blurs at 0.75 confidence when sensitivity is 0.1", () => {
    expect(shouldBlur(0.75, 0.1)).toBe(true);
  });

  it("uses user sensitivity when above the 0.75 floor", () => {
    expect(effectiveThreshold(0.9)).toBe(0.9);
    expect(shouldBlur(0.89, 0.9)).toBe(false);
    expect(shouldBlur(0.9, 0.9)).toBe(true);
  });

  it("uses 0.75 floor for Medium sensitivity (0.75)", () => {
    expect(effectiveThreshold(0.75)).toBe(0.75);
    expect(shouldBlur(0.74, 0.75)).toBe(false);
    expect(shouldBlur(0.75, 0.75)).toBe(true);
  });

  it("respects nudity toggle when protection is on", () => {
    const settingsOn = {
      ...DEFAULT_SETTINGS,
      protectionEnabled: true,
      categories: { ...DEFAULT_SETTINGS.categories, nudity: true },
    };
    const settingsOff = {
      ...DEFAULT_SETTINGS,
      protectionEnabled: true,
      categories: {
        ...DEFAULT_SETTINGS.categories,
        nudity: false,
        violence: false,
      },
    };
    expect(getEnabledCategories(settingsOn)).toEqual(["nudity", "violence"]);
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
