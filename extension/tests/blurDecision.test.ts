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
};

describe("blurDecision", () => {
  it("BLUR only when label is NSFW and score meets threshold", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "NSFW",
        score: 0.82,
      })
    ).toEqual({ action: "BLUR", reason: "NSFW_confirmed" });
  });

  it("CLEAR immediately for SFW regardless of score", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "SFW",
        score: 0.95,
      })
    ).toEqual({ action: "CLEAR", reason: "SFW" });
  });

  it("CLEAR when NSFW score is below threshold", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "NSFW",
        score: 0.31,
      })
    ).toEqual({ action: "CLEAR", reason: "NSFW_below_threshold" });
  });

  it("DROP stale generation", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "NSFW",
        score: 0.9,
        resultGeneration: 2,
        currentGeneration: 3,
      })
    ).toEqual({ action: "DROP", reason: "stale_gen" });
  });

  it("DROP stale frame sequence", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        label: "SFW",
        score: 0.1,
        frameSeq: 5,
        lastProcessedFrameSeq: 8,
      })
    ).toEqual({ action: "DROP", reason: "stale_frame" });
  });

  it("normalizes label from backend string", () => {
    expect(normalizeBlurLabel("NSFW", 0.2)).toBe("NSFW");
    expect(normalizeBlurLabel(undefined, 0.6)).toBe("NSFW");
    expect(normalizeBlurLabel(undefined, 0.4)).toBe("SFW");
  });
});
