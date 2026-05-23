// SafeView — blurDecision.test.ts

import {
  evaluateBlurState,
  normalizeBlurLabel,
} from "../src/background/blurDecision";

const baseState = {
  threshold: 0.75,
  frameSeq: 10,
  lastProcessedFrameSeq: 9,
  resultGeneration: 3,
  currentGeneration: 3,
  analysisInFlight: false,
  lastUnsafe: false,
  backendTrusted: true,
  firstDecisionMade: false,
  safeStreak: 0,
  uncertainStreak: 0,
  nudityDetected: false,
};

describe("blurDecision", () => {
  it("BLUR when nudity detected and score meets unsafe threshold", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "NSFW",
        score: 0.82,
        nudityDetected: true,
      })
    ).toEqual({ action: "BLUR", reason: "unsafe" });
  });

  it("HOLD in uncertain band on first frame", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "NSFW",
        score: 0.55,
        nudityDetected: false,
      })
    ).toEqual({ action: "HOLD", reason: "uncertain" });
  });

  it("CLEAR after uncertain band persists without high nudity", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "NSFW",
        score: 0.55,
        uncertainStreak: 1,
        nudityDetected: false,
      })
    ).toEqual({ action: "CLEAR", reason: "uncertain_cleared" });
  });

  it("CLEAR immediately on first safe frame", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "SFW",
        score: 0.4,
      })
    ).toEqual({ action: "CLEAR", reason: "safe" });
  });

  it("HOLD first safe frame after prior unsafe until streak met", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "SFW",
        score: 0.2,
        lastUnsafe: true,
        firstDecisionMade: true,
        safeStreak: 0,
      })
    ).toEqual({ action: "HOLD", reason: "building_safe_streak" });
  });

  it("CLEAR after safe streak following unsafe", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "SFW",
        score: 0.2,
        lastUnsafe: true,
        firstDecisionMade: true,
        safeStreak: 1,
      })
    ).toEqual({ action: "CLEAR", reason: "safe_after_unsafe" });
  });

  it("HOLD when backend is untrusted (fail closed)", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "SFW",
        score: 0.1,
        backendTrusted: false,
      })
    ).toEqual({ action: "HOLD", reason: "backend_untrusted" });
  });

  it("DROP stale generation", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "NSFW",
        score: 0.9,
        nudityDetected: true,
        resultGeneration: 2,
        currentGeneration: 3,
      })
    ).toEqual({ action: "DROP", reason: "stale_gen" });
  });

  it("normalizes label from backend string", () => {
    expect(normalizeBlurLabel("NSFW", 0.2)).toBe("NSFW");
    expect(normalizeBlurLabel(undefined, 0.6)).toBe("NSFW");
    expect(normalizeBlurLabel(undefined, 0.4)).toBe("SFW");
  });
});
