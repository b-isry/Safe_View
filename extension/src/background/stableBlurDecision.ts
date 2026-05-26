// SafeView — stableBlurDecision.ts
// Purpose: Hysteresis + hold + safe-streak state machine for demo classifier blur.

import type { AnalyzeImageResponse } from "../shared/apiTypes";
import {
  BLUR_OFF_THRESHOLD,
  BLUR_ON_THRESHOLD,
  BLUR_TTL_MS,
  MIN_BLUR_HOLD_MS,
  SAFE_FRAMES_TO_CLEAR,
} from "../shared/stableBlurPolicy";

export type StableBlurCommand = "BLUR" | "CLEAR" | "KEEP";

export interface StableBlurState {
  frameSeq: number;
  latestAppliedFrameSeq: number;
  pending: boolean;
  isBlurred: boolean;
  unsafeStreak: number;
  safeStreak: number;
  lastUnsafeAt: number;
  lastSafeAt: number;
  lastResultAt: number;
  lastCommand: StableBlurCommand;
}

export interface StableBlurDecision {
  command: StableBlurCommand;
  reason: string;
  mode: "full" | "none";
  score: number;
  state: StableBlurState;
}

export interface StableBlurEvaluateInput {
  response: Pick<
    AnalyzeImageResponse,
    "model_loaded" | "action" | "detected" | "confidence"
  >;
  state: StableBlurState;
  frameSeq: number;
  lastProcessedFrameSeq: number;
  requestId: number;
  latestRequestId: number;
  resultGeneration: number;
  currentGeneration: number;
  backendTrusted: boolean;
  nowMs?: number;
}

export function createStableBlurState(): StableBlurState {
  return {
    frameSeq: 0,
    latestAppliedFrameSeq: 0,
    pending: false,
    isBlurred: false,
    unsafeStreak: 0,
    safeStreak: 0,
    lastUnsafeAt: 0,
    lastSafeAt: 0,
    lastResultAt: 0,
    lastCommand: "CLEAR",
  };
}

export function decideStableBlur(
  response: Pick<
    AnalyzeImageResponse,
    "model_loaded" | "action" | "detected" | "confidence"
  >,
  state: StableBlurState,
  options: { nowMs?: number; backendTrusted?: boolean } = {}
): StableBlurDecision {
  const now = options.nowMs ?? Date.now();
  const backendTrusted = options.backendTrusted ?? true;
  const score = Number(response.confidence ?? 0);
  const next: StableBlurState = { ...state };

  if (!backendTrusted || response.model_loaded === false) {
    if (next.isBlurred && next.lastUnsafeAt > 0 && now - next.lastUnsafeAt > BLUR_TTL_MS) {
      next.isBlurred = false;
      next.safeStreak = 0;
      next.unsafeStreak = 0;
      next.lastCommand = "CLEAR";
      return {
        command: "CLEAR",
        reason: "backend_unavailable_ttl",
        mode: "none",
        score,
        state: next,
      };
    }
    if (next.isBlurred) {
      next.lastCommand = "KEEP";
      return {
        command: "KEEP",
        reason: "backend_unavailable_keep_blur",
        mode: "full",
        score,
        state: next,
      };
    }
    next.lastCommand = "KEEP";
    return {
      command: "KEEP",
      reason: "backend_unavailable",
      mode: "none",
      score,
      state: next,
    };
  }

  if (
    next.isBlurred &&
    next.lastUnsafeAt > 0 &&
    now - next.lastUnsafeAt > BLUR_TTL_MS
  ) {
    next.isBlurred = false;
    next.safeStreak = 0;
    next.unsafeStreak = 0;
    next.lastCommand = "CLEAR";
    return {
      command: "CLEAR",
      reason: "blur_ttl_expired",
      mode: "none",
      score,
      state: next,
    };
  }

  // Demo: score drives blur ON/OFF — backend gate may return ALLOW while confidence is high.
  const isUnsafe =
    response.model_loaded !== false && score >= BLUR_ON_THRESHOLD;

  const isDefinitelySafe = score < BLUR_OFF_THRESHOLD;

  const isBorderline =
    score >= BLUR_OFF_THRESHOLD && score < BLUR_ON_THRESHOLD;

  if (isUnsafe) {
    next.unsafeStreak += 1;
    next.safeStreak = 0;
    next.lastUnsafeAt = now;
    next.lastResultAt = now;
    next.isBlurred = true;
    next.lastCommand = "BLUR";
    return {
      command: "BLUR",
      reason: "unsafe_above_blur_on_threshold",
      mode: "full",
      score,
      state: next,
    };
  }

  if (isBorderline && next.isBlurred) {
    next.lastResultAt = now;
    next.lastCommand = "KEEP";
    return {
      command: "KEEP",
      reason: "borderline_keep_existing_blur",
      mode: "full",
      score,
      state: next,
    };
  }

  if (isDefinitelySafe) {
    next.safeStreak += 1;
    next.unsafeStreak = 0;
    next.lastSafeAt = now;
    next.lastResultAt = now;
    const heldLongEnough =
      next.lastUnsafeAt <= 0 || now - next.lastUnsafeAt >= MIN_BLUR_HOLD_MS;
    const enoughSafeFrames = next.safeStreak >= SAFE_FRAMES_TO_CLEAR;

    if (next.isBlurred && (!heldLongEnough || !enoughSafeFrames)) {
      next.lastCommand = "KEEP";
      return {
        command: "KEEP",
        reason: "waiting_for_safe_confirmation",
        mode: "full",
        score,
        state: next,
      };
    }

    if (next.isBlurred) {
      next.isBlurred = false;
      next.lastCommand = "CLEAR";
      return {
        command: "CLEAR",
        reason: "safe_confirmed",
        mode: "none",
        score,
        state: next,
      };
    }

    next.lastCommand = "CLEAR";
    return {
      command: "CLEAR",
      reason: "safe_confirmed",
      mode: "none",
      score,
      state: next,
    };
  }

  next.lastResultAt = now;
  if (next.isBlurred) {
    next.lastCommand = "KEEP";
    return {
      command: "KEEP",
      reason: "default_keep_current_state",
      mode: "full",
      score,
      state: next,
    };
  }

  next.lastCommand = "CLEAR";
  return {
    command: "CLEAR",
    reason: "default_keep_current_state",
    mode: "none",
    score,
    state: next,
  };
}

export function evaluateStableDemoBlur(
  input: StableBlurEvaluateInput
): StableBlurDecision | { dropped: true; reason: string } {
  if (input.resultGeneration !== input.currentGeneration) {
    return { dropped: true, reason: "stale_gen" };
  }

  if (input.frameSeq > 0 && input.frameSeq < input.lastProcessedFrameSeq) {
    return { dropped: true, reason: "stale_frame" };
  }

  if (input.requestId > 0 && input.requestId < input.latestRequestId) {
    return { dropped: true, reason: "stale_request" };
  }

  const withSeq: StableBlurState = {
    ...input.state,
    frameSeq: input.frameSeq,
    pending: false,
  };

  const decision = decideStableBlur(input.response, withSeq, {
    nowMs: input.nowMs,
    backendTrusted: input.backendTrusted,
  });

  decision.state.latestAppliedFrameSeq = Math.max(
    decision.state.latestAppliedFrameSeq,
    input.frameSeq
  );

  return decision;
}

export function logStableBlurDecision(
  decision: StableBlurDecision,
  meta: {
    frameSeq: number;
    backendMs?: number;
    totalMs?: number;
  }
): void {
  const { state } = decision;
  console.log(
    "[SafeView][StableDecision] frameSeq=%s score=%s command=%s reason=%s safeStreak=%s unsafeStreak=%s isBlurred=%s backendMs=%s totalMs=%s",
    meta.frameSeq,
    decision.score.toFixed(2),
    decision.command,
    decision.reason,
    state.safeStreak,
    state.unsafeStreak,
    state.isBlurred,
    meta.backendMs ?? "-",
    meta.totalMs ?? "-"
  );
}
