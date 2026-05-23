// SafeView — blurDecision.test.ts

import {
  applyBlurStateUpdates,
  evaluateBlurState,
  normalizeBlurLabel,
} from "../src/background/blurDecision";
import { UNSAFE_LOCK_MS } from "../src/background/latencyPolicy";

const baseState = {
  score: 0,
  nudityDetected: false,
  frameSeq: 10,
  lastProcessedFrameSeq: 9,
  resultGeneration: 3,
  currentGeneration: 3,
  backendTrusted: true,
  modelLoaded: true,
  requestId: 5,
  latestRequestId: 5,
  unsafeSeen: false,
  firstDecisionMade: false,
  safeStreak: 0,
  unsafeLockUntil: 0,
  nowMs: 1_000_000,
};

describe("blurDecision", () => {
  it("BLUR when nudity detected and score meets unsafe threshold (0.72)", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.82,
        nudityDetected: true,
      })
    ).toEqual({ action: "BLUR", reason: "unsafe" });
  });

  it("BLUR unsafe even after video was previously marked safe", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.8,
        nudityDetected: true,
        firstDecisionMade: true,
        unsafeSeen: false,
      })
    ).toEqual({ action: "BLUR", reason: "unsafe" });
  });

  it("BLUR suspicious score before unsafe confirmation", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.65,
        nudityDetected: false,
      })
    ).toEqual({ action: "BLUR", reason: "suspicious" });
  });

  it("BLUR suspicious when detected but below unsafe threshold", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.7,
        nudityDetected: true,
      })
    ).toEqual({ action: "BLUR", reason: "suspicious" });
  });

  it("HOLD uncertain band when score is below suspicious threshold", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.55,
        nudityDetected: true,
      })
    ).toEqual({ action: "HOLD", reason: "uncertain_precheck" });
  });

  it("CLEAR on first clearly safe frame", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.4,
        nudityDetected: false,
      })
    ).toEqual({ action: "CLEAR", reason: "first_safe" });
  });

  it("HOLD high score when nudity not detected (not below safe threshold)", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.95,
        nudityDetected: false,
      })
    ).toEqual({ action: "BLUR", reason: "suspicious" });
  });

  it("HOLD during unsafe lock after prior unsafe", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.2,
        nudityDetected: false,
        unsafeSeen: true,
        firstDecisionMade: true,
        unsafeLockUntil: baseState.nowMs + 5000,
      })
    ).toEqual({ action: "HOLD", reason: "unsafe_lock" });
  });

  it("HOLD first safe frame after lock expires until streak met", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.2,
        nudityDetected: false,
        unsafeSeen: true,
        firstDecisionMade: true,
        safeStreak: 0,
        unsafeLockUntil: 0,
      })
    ).toEqual({ action: "HOLD", reason: "building_safe_streak" });
  });

  it("CLEAR after safe streak following unsafe", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.2,
        nudityDetected: false,
        unsafeSeen: true,
        firstDecisionMade: true,
        safeStreak: 14,
        unsafeLockUntil: 0,
      })
    ).toEqual({ action: "CLEAR", reason: "safe_after_unsafe" });
  });

  it("HOLD backend_untrusted when video is still unknown", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.1,
        backendTrusted: false,
      })
    ).toEqual({ action: "HOLD", reason: "backend_untrusted" });
  });

  it("HOLD backend_retry when video was already clear", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.1,
        backendTrusted: false,
        firstDecisionMade: true,
        unsafeSeen: false,
      })
    ).toEqual({ action: "HOLD", reason: "backend_retry" });
  });

  it("HOLD when model is not loaded", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.1,
        modelLoaded: false,
      })
    ).toEqual({ action: "HOLD", reason: "model_not_loaded" });
  });

  it("DROP stale requestId", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.9,
        nudityDetected: true,
        requestId: 3,
        latestRequestId: 5,
      })
    ).toEqual({ action: "DROP", reason: "stale_request" });
  });

  it("applyBlurStateUpdates sets unsafe lock only on confirmed unsafe", () => {
    const nowMs = 1_000_000;
    const updates = applyBlurStateUpdates(
      {
        unsafeSeen: false,
        firstDecisionMade: false,
        safeStreak: 0,
        unsafeLockUntil: 0,
        nowMs,
      },
      { action: "BLUR", reason: "unsafe" }
    );

    expect(updates.unsafeSeen).toBe(true);
    expect(updates.unsafeLockUntil).toBe(nowMs + UNSAFE_LOCK_MS);
  });

  it("applyBlurStateUpdates does not lock on suspicious blur", () => {
    const updates = applyBlurStateUpdates(
      {
        unsafeSeen: false,
        firstDecisionMade: true,
        safeStreak: 3,
        unsafeLockUntil: 0,
        nowMs: 1_000_000,
      },
      { action: "BLUR", reason: "suspicious" }
    );

    expect(updates.unsafeSeen).toBe(false);
    expect(updates.unsafeLockUntil).toBe(0);
    expect(updates.safeStreak).toBe(0);
  });

  it("normalizes label from backend string", () => {
    expect(normalizeBlurLabel("NSFW", 0.2)).toBe("NSFW");
    expect(normalizeBlurLabel(undefined, 0.6)).toBe("NSFW");
    expect(normalizeBlurLabel(undefined, 0.4)).toBe("SFW");
  });
});
