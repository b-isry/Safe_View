// SafeView — blurDecision.test.ts

import {
  applyBlurStateUpdates,
  evaluateBlurState,
  normalizeBlurLabel,
  type ContentTypeGate,
} from "../src/background/blurDecision";
import { UNSAFE_LOCK_MS } from "../src/background/latencyPolicy";

const realHuman: ContentTypeGate = {
  is_animation: false,
  is_real_human: true,
  gate_reason: null,
};

const animationGate: ContentTypeGate = {
  is_animation: true,
  is_real_human: false,
  gate_reason: "animation_skip",
};

const baseState = {
  score: 0,
  nudityDetected: false,
  backendAction: null as "BLUR" | "ALLOW" | null,
  contentType: null as ContentTypeGate | null,
  gateReason: null as string | null,
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
  it("BLUR when violence meets unsafe threshold (0.72)", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0,
        violenceScore: 0.88,
        nudityDetected: false,
        violenceDetected: true,
        backendAction: "ALLOW",
        violenceAction: "BLUR",
      })
    ).toEqual({ action: "BLUR", reason: "violence" });
  });

  it("BLUR when real human nudity meets unsafe threshold (0.72)", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.82,
        nudityDetected: true,
        backendAction: "BLUR",
        contentType: { ...realHuman, gate_reason: "real_human_nudity" },
        gateReason: "real_human_nudity",
      })
    ).toEqual({ action: "BLUR", reason: "real_human_nudity" });
  });

  it("BLUR real human nudity even after video was previously marked safe", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.8,
        nudityDetected: true,
        backendAction: "BLUR",
        contentType: { ...realHuman, gate_reason: "real_human_nudity" },
        gateReason: "real_human_nudity",
        firstDecisionMade: true,
        unsafeSeen: false,
      })
    ).toEqual({ action: "BLUR", reason: "real_human_nudity" });
  });

  it("CLEAR animation_skip immediately", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.95,
        nudityDetected: false,
        backendAction: "ALLOW",
        contentType: animationGate,
        gateReason: "animation_skip",
      })
    ).toEqual({ action: "CLEAR", reason: "animation_skip" });
  });

  it("CLEAR no_real_human gate", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.7,
        nudityDetected: true,
        backendAction: "ALLOW",
        contentType: {
          is_animation: false,
          is_real_human: false,
          gate_reason: "no_real_human",
        },
        gateReason: "no_real_human",
      })
    ).toEqual({ action: "CLEAR", reason: "no_real_human" });
  });

  it("does not BLUR high score when nudity not detected (no suspicious blur)", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.95,
        nudityDetected: false,
        backendAction: "ALLOW",
      })
    ).toEqual({ action: "CLEAR", reason: "first_safe" });
  });

  it("CLEAR when nudity flagged but backend ALLOW (below blur threshold)", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.65,
        nudityDetected: true,
        backendAction: "ALLOW",
        contentType: realHuman,
        gateReason: "real_human_safe",
        firstDecisionMade: true,
      })
    ).toEqual({ action: "CLEAR", reason: "real_human_safe" });
  });

  it("CLEAR on first clearly safe frame", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.4,
        nudityDetected: false,
        backendAction: "ALLOW",
        contentType: realHuman,
        gateReason: "real_human_safe",
      })
    ).toEqual({ action: "CLEAR", reason: "real_human_safe" });
  });

  it("HOLD during unsafe lock after prior unsafe", () => {
    expect(
      evaluateBlurState({
        ...baseState,
        score: 0.2,
        nudityDetected: false,
        backendAction: "ALLOW",
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
        backendAction: "ALLOW",
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
        backendAction: "ALLOW",
        unsafeSeen: true,
        firstDecisionMade: true,
        safeStreak: 9,
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
        backendAction: "BLUR",
        contentType: realHuman,
        requestId: 3,
        latestRequestId: 5,
      })
    ).toEqual({ action: "DROP", reason: "stale_request" });
  });

  it("applyBlurStateUpdates sets unsafe lock on real human nudity blur", () => {
    const nowMs = 1_000_000;
    const updates = applyBlurStateUpdates(
      {
        unsafeSeen: false,
        firstDecisionMade: false,
        safeStreak: 0,
        unsafeLockUntil: 0,
        nowMs,
      },
      { action: "BLUR", reason: "real_human_nudity" }
    );

    expect(updates.unsafeSeen).toBe(true);
    expect(updates.unsafeLockUntil).toBe(nowMs + UNSAFE_LOCK_MS);
  });

  it("normalizes label from backend string", () => {
    expect(normalizeBlurLabel("NSFW", 0.2)).toBe("NSFW");
    expect(normalizeBlurLabel(undefined, 0.6)).toBe("NSFW");
    expect(normalizeBlurLabel(undefined, 0.4)).toBe("SFW");
  });
});
