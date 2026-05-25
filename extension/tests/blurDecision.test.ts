// SafeView — blurDecision.test.ts

import {
  applyBlurStateUpdates,
  evaluateBlurState,
  evaluateDemoBlurSwitch,
  normalizeBlurLabel,
  shouldBlurFrame,
} from "../src/background/blurDecision";
import { createStableBlurState } from "../src/background/stableBlurDecision";
import {
  BLUR_ON_THRESHOLD,
  MIN_BLUR_HOLD_MS,
  SAFE_FRAMES_TO_CLEAR,
} from "../src/shared/stableBlurPolicy";
import { UNSAFE_LOCK_MS } from "../src/background/latencyPolicy";

const baseState = {
  score: 0,
  nudityDetected: false,
  violenceDetected: false,
  nudityAction: null as "BLUR" | "ALLOW" | null,
  violenceAction: null as "BLUR" | "ALLOW" | null,
  violenceDetections: [],
  contentType: null,
  gateReason: null,
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
  lastUnsafeAt: 0,
  nowMs: 1_000_000,
};

const demoBase = {
  frameSeq: 10,
  lastProcessedFrameSeq: 9,
  requestId: 5,
  latestRequestId: 5,
  resultGeneration: 3,
  currentGeneration: 3,
  backendTrusted: true,
  stableState: createStableBlurState(),
  nowMs: 50_000,
};

describe("blurDecision", () => {
  it("shouldBlurFrame requires model_loaded, BLUR, detected, and threshold", () => {
    expect(
      shouldBlurFrame(
        {
          model_loaded: true,
          action: "BLUR",
          detected: true,
          confidence: 0.91,
        },
        BLUR_ON_THRESHOLD
      )
    ).toBe(true);

    expect(
      shouldBlurFrame(
        {
          model_loaded: true,
          action: "ALLOW",
          detected: false,
          confidence: 0.91,
        },
        BLUR_ON_THRESHOLD
      )
    ).toBe(false);
  });

  it("demo stable BLUR on unsafe frame", () => {
    expect(
      evaluateDemoBlurSwitch({
        ...demoBase,
        response: {
          model_loaded: true,
          action: "BLUR",
          detected: true,
          confidence: 0.91,
        },
      })
    ).toMatchObject({
      action: "BLUR",
      reason: "unsafe_above_blur_on_threshold",
      blurMode: "full",
    });
  });

  it("demo stable KEEP on borderline frame after blur", () => {
    const blurred = evaluateDemoBlurSwitch({
      ...demoBase,
      frameSeq: 10,
      response: {
        model_loaded: true,
        action: "BLUR",
        detected: true,
        confidence: 0.88,
      },
    });
    expect(blurred.action).toBe("BLUR");

    expect(
      evaluateDemoBlurSwitch({
        ...demoBase,
        frameSeq: 11,
        lastProcessedFrameSeq: 10,
        stableState: blurred.stableState,
        nowMs: demoBase.nowMs! + 200,
        response: {
          model_loaded: true,
          action: "BLUR",
          detected: true,
          confidence: 0.69,
        },
      })
    ).toMatchObject({
      action: "KEEP",
      reason: "borderline_keep_existing_blur",
    });
  });

  it("demo stable CLEAR only after safe streak and hold", () => {
    const t0 = 100_000;
    let stable = createStableBlurState();
    const blur = evaluateDemoBlurSwitch({
      ...demoBase,
      frameSeq: 1,
      lastProcessedFrameSeq: 0,
      nowMs: t0,
      stableState: stable,
      response: {
        model_loaded: true,
        action: "BLUR",
        detected: true,
        confidence: 0.9,
      },
    });
    stable = blur.stableState!;

    for (let i = 2; i <= SAFE_FRAMES_TO_CLEAR; i += 1) {
      const mid = evaluateDemoBlurSwitch({
        ...demoBase,
        frameSeq: i,
        lastProcessedFrameSeq: i - 1,
        nowMs: t0 + i * 50,
        stableState: stable,
        response: {
          model_loaded: true,
          action: "ALLOW",
          detected: false,
          confidence: 0.1,
        },
      });
      if (i < SAFE_FRAMES_TO_CLEAR) {
        expect(mid.action).toBe("KEEP");
      }
      stable = mid.stableState!;
    }

    const cleared = evaluateDemoBlurSwitch({
      ...demoBase,
      frameSeq: SAFE_FRAMES_TO_CLEAR + 1,
      lastProcessedFrameSeq: SAFE_FRAMES_TO_CLEAR,
      nowMs: t0 + MIN_BLUR_HOLD_MS,
      stableState: stable,
      response: {
        model_loaded: true,
        action: "ALLOW",
        detected: false,
        confidence: 0.1,
      },
    });
    expect(cleared.action).toBe("CLEAR");
    expect(cleared.reason).toBe("safe_confirmed");
  });

  it("demo stable KEEP on backend error while blurred", () => {
    const blurred = evaluateDemoBlurSwitch({
      ...demoBase,
      response: {
        model_loaded: true,
        action: "BLUR",
        detected: true,
        confidence: 0.9,
      },
    });

    expect(
      evaluateDemoBlurSwitch({
        ...demoBase,
        frameSeq: 11,
        lastProcessedFrameSeq: 10,
        backendTrusted: false,
        stableState: blurred.stableState,
        response: {
          model_loaded: false,
          action: "ALLOW",
          detected: false,
          confidence: 0,
        },
      })
    ).toMatchObject({
      action: "KEEP",
      reason: "backend_unavailable_keep_blur",
    });
  });

  it("demo switch DROP stale frame seq", () => {
    expect(
      evaluateDemoBlurSwitch({
        ...demoBase,
        frameSeq: 5,
        lastProcessedFrameSeq: 8,
        response: {
          model_loaded: true,
          action: "BLUR",
          detected: true,
          confidence: 0.9,
        },
      })
    ).toEqual({ action: "DROP", reason: "stale_frame" });
  });

  it("BLUR when violence meets threshold with region boxes", () => {
    const evaluation = evaluateBlurState({
      ...baseState,
      violenceScore: 0.88,
      violenceDetected: true,
      violenceAction: "BLUR",
      violenceDetections: [
        { class: "weapon", confidence: 0.88, box: [0.1, 0.2, 0.5, 0.7] },
      ],
    });
    expect(evaluation.action).toBe("BLUR");
    if (evaluation.action === "BLUR") {
      expect(evaluation.blurMode).toBe("regions");
    }
  });

  it("applyBlurStateUpdates sets lastUnsafeAt on BLUR", () => {
    const nowMs = 5_000;
    const updates = applyBlurStateUpdates(
      {
        unsafeSeen: false,
        firstDecisionMade: false,
        safeStreak: 0,
        unsafeLockUntil: 0,
        lastUnsafeAt: 0,
        nowMs,
      },
      { action: "BLUR", reason: "nudity_full", blurMode: "full" }
    );
    expect(updates.unsafeSeen).toBe(true);
    expect(updates.lastUnsafeAt).toBe(nowMs);
    expect(updates.unsafeLockUntil).toBe(nowMs + UNSAFE_LOCK_MS);
  });
});
