// SafeView — stableBlurDecision.test.ts

import {
  createStableBlurState,
  decideStableBlur,
  evaluateStableDemoBlur,
} from "../src/background/stableBlurDecision";
import {
  BLUR_ON_THRESHOLD,
  BLUR_OFF_THRESHOLD,
  MIN_BLUR_HOLD_MS,
  SAFE_FRAMES_TO_CLEAR,
} from "../src/shared/stableBlurPolicy";

const unsafeResponse = {
  model_loaded: true,
  action: "BLUR" as const,
  detected: true,
  confidence: 0.85,
};

const belowThresholdResponse = {
  model_loaded: true,
  action: "ALLOW" as const,
  detected: false,
  confidence: 0.49,
};

const safeResponse = {
  model_loaded: true,
  action: "ALLOW" as const,
  detected: false,
  confidence: 0.2,
};

describe("stableBlurDecision", () => {
  it("BLUR when score is at or above BLUR_ON_THRESHOLD", () => {
    const state = createStableBlurState();
    const result = decideStableBlur(unsafeResponse, state, {
      nowMs: 10_000,
      backendTrusted: true,
    });
    expect(result.command).toBe("BLUR");
    expect(result.reason).toBe("unsafe_above_blur_on_threshold");
    expect(result.state.isBlurred).toBe(true);
  });

  it("CLEAR when score drops below 50% after blur", () => {
    let state = createStableBlurState();
    const t0 = 30_000;
    state = decideStableBlur(unsafeResponse, state, { nowMs: t0 }).state;
    for (let i = 1; i < SAFE_FRAMES_TO_CLEAR; i += 1) {
      state = decideStableBlur(belowThresholdResponse, state, {
        nowMs: t0 + MIN_BLUR_HOLD_MS,
      }).state;
    }
    const cleared = decideStableBlur(belowThresholdResponse, state, {
      nowMs: t0 + MIN_BLUR_HOLD_MS + 100,
    });
    expect(cleared.command).toBe("CLEAR");
    expect(cleared.state.isBlurred).toBe(false);
  });

  it("CLEAR only after safe streak and minimum hold", () => {
    let state = createStableBlurState();
    const t0 = 20_000;
    state = decideStableBlur(unsafeResponse, state, { nowMs: t0 }).state;

    for (let i = 1; i < SAFE_FRAMES_TO_CLEAR; i += 1) {
      const mid = decideStableBlur(safeResponse, state, {
        nowMs: t0 + i * 100,
      });
      expect(mid.command).toBe("KEEP");
      expect(mid.reason).toBe("waiting_for_safe_confirmation");
      state = mid.state;
    }

    const beforeHold = decideStableBlur(safeResponse, state, {
      nowMs: t0 + MIN_BLUR_HOLD_MS - 1,
    });
    expect(beforeHold.command).toBe("KEEP");

    const cleared = decideStableBlur(safeResponse, beforeHold.state, {
      nowMs: t0 + MIN_BLUR_HOLD_MS,
    });
    expect(cleared.command).toBe("CLEAR");
    expect(cleared.reason).toBe("safe_confirmed");
    expect(cleared.state.isBlurred).toBe(false);
  });

  it("score below 50% does not turn blur on when unblurred", () => {
    const state = createStableBlurState();
    const result = decideStableBlur(belowThresholdResponse, state, { nowMs: 1_000 });
    expect(result.command).toBe("CLEAR");
    expect(result.state.isBlurred).toBe(false);
  });

  it("BLUR at exactly 50% confidence", () => {
    const state = createStableBlurState();
    const result = decideStableBlur(
      {
        model_loaded: true,
        action: "ALLOW",
        detected: false,
        confidence: 0.5,
      },
      state,
      { nowMs: 1_000 }
    );
    expect(result.command).toBe("BLUR");
    expect(result.state.isBlurred).toBe(true);
  });

  it("BLUR on high score when backend gate returned ALLOW (score-primary demo)", () => {
    const state = createStableBlurState();
    const result = decideStableBlur(
      {
        model_loaded: true,
        action: "ALLOW",
        detected: false,
        confidence: 0.77,
      },
      state,
      { nowMs: 1_000, backendTrusted: true }
    );
    expect(result.command).toBe("BLUR");
    expect(result.reason).toBe("unsafe_above_blur_on_threshold");
    expect(result.state.isBlurred).toBe(true);
  });

  it("evaluateStableDemoBlur DROPs stale frame seq", () => {
    const result = evaluateStableDemoBlur({
      response: unsafeResponse,
      state: createStableBlurState(),
      frameSeq: 3,
      lastProcessedFrameSeq: 5,
      requestId: 1,
      latestRequestId: 1,
      resultGeneration: 1,
      currentGeneration: 1,
      backendTrusted: true,
    });
    expect(result).toEqual({ dropped: true, reason: "stale_frame" });
  });

  it("keeps blur on backend error when already blurred", () => {
    let state = createStableBlurState();
    state = decideStableBlur(unsafeResponse, state, { nowMs: 5_000 }).state;
    const result = decideStableBlur(
      { model_loaded: false, action: "ALLOW", detected: false, confidence: 0 },
      state,
      { nowMs: 5_100, backendTrusted: false }
    );
    expect(result.command).toBe("KEEP");
    expect(result.reason).toBe("backend_unavailable_keep_blur");
  });

  it("uses 50% as blur on/off split", () => {
    expect(BLUR_ON_THRESHOLD).toBe(0.5);
    expect(BLUR_OFF_THRESHOLD).toBe(0.5);
    expect(belowThresholdResponse.confidence).toBeLessThan(BLUR_OFF_THRESHOLD);
    expect(unsafeResponse.confidence).toBeGreaterThanOrEqual(BLUR_ON_THRESHOLD);
  });
});
