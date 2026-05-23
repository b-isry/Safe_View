// SafeView — blurDecision.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Nudity-only BLUR / CLEAR state machine (detected + confidence only).

import {
  AFTER_UNSAFE_SAFE_CLEAR_STREAK,
  SAFE_THRESHOLD,
  SUSPICIOUS_THRESHOLD,
  UNSAFE_LOCK_MS,
  UNSAFE_THRESHOLD,
} from "./latencyPolicy";

export type BlurLabel = "NSFW" | "SFW";

export type BlurDecisionAction = "BLUR" | "CLEAR";

export type BlurEvaluation =
  | { action: BlurDecisionAction; reason: string }
  | { action: "HOLD"; reason: string }
  | { action: "DROP"; reason: string };

/**
 * Inputs for one frame's blur decision (after /analyze-image).
 * Uses only nudity model detected + confidence — not face/person/skin heuristics.
 */
export interface FrameBlurState {
  score: number;
  nudityDetected: boolean;
  frameSeq: number;
  lastProcessedFrameSeq: number;
  resultGeneration: number;
  currentGeneration: number;
  /** False when backend is offline, timed out, or parse failed. */
  backendTrusted: boolean;
  /** False when the nudity model is not loaded on the server. */
  modelLoaded: boolean;
  requestId: number;
  latestRequestId: number;
  /** True after any confirmed unsafe nudity on this video. */
  unsafeSeen: boolean;
  firstDecisionMade: boolean;
  safeStreak: number;
  /** Do not clear blur before this timestamp (ms). */
  unsafeLockUntil: number;
  nowMs: number;
}

/**
 * Map backend label for logging only (not used for blur decisions).
 */
export function normalizeBlurLabel(
  label: string | undefined,
  confidence: number
): BlurLabel {
  if (label === "NSFW" || label === "SFW") {
    return label;
  }

  return confidence >= SAFE_THRESHOLD ? "NSFW" : "SFW";
}

function isClearlySafe(detected: boolean, score: number): boolean {
  return !detected && score < SAFE_THRESHOLD;
}

function isClearlyUnsafe(detected: boolean, score: number): boolean {
  return detected && score >= UNSAFE_THRESHOLD;
}

function isSuspicious(score: number): boolean {
  return score >= SUSPICIOUS_THRESHOLD;
}

function isUncertainBand(score: number): boolean {
  return score >= SAFE_THRESHOLD && score < UNSAFE_THRESHOLD;
}

/**
 * Sole blur decision function — all BLUR/CLEAR commands must follow this.
 */
export function evaluateBlurState(state: FrameBlurState): BlurEvaluation {
  if (state.resultGeneration !== state.currentGeneration) {
    return { action: "DROP", reason: "stale_gen" };
  }

  if (state.frameSeq < state.lastProcessedFrameSeq) {
    return { action: "DROP", reason: "stale_frame" };
  }

  if (state.requestId > 0 && state.requestId < state.latestRequestId) {
    return { action: "DROP", reason: "stale_request" };
  }

  if (!state.backendTrusted) {
    if (state.firstDecisionMade && !state.unsafeSeen) {
      return { action: "HOLD", reason: "backend_retry" };
    }

    return { action: "HOLD", reason: "backend_untrusted" };
  }

  if (!state.modelLoaded) {
    if (state.firstDecisionMade && !state.unsafeSeen) {
      return { action: "HOLD", reason: "model_retry" };
    }

    return { action: "HOLD", reason: "model_not_loaded" };
  }

  if (isClearlyUnsafe(state.nudityDetected, state.score)) {
    return { action: "BLUR", reason: "unsafe" };
  }

  if (isSuspicious(state.score)) {
    return { action: "BLUR", reason: "suspicious" };
  }

  if (isClearlySafe(state.nudityDetected, state.score)) {
    if (!state.unsafeSeen) {
      return { action: "CLEAR", reason: "first_safe" };
    }

    if (state.nowMs < state.unsafeLockUntil) {
      return { action: "HOLD", reason: "unsafe_lock" };
    }

    const nextStreak = state.safeStreak + 1;
    if (nextStreak >= AFTER_UNSAFE_SAFE_CLEAR_STREAK) {
      return { action: "CLEAR", reason: "safe_after_unsafe" };
    }

    return { action: "HOLD", reason: "building_safe_streak" };
  }

  if (isUncertainBand(state.score)) {
    if (!state.firstDecisionMade) {
      return { action: "HOLD", reason: "uncertain_precheck" };
    }

    if (!state.unsafeSeen) {
      return { action: "HOLD", reason: "uncertain_no_reblur" };
    }

    if (state.nowMs < state.unsafeLockUntil) {
      return { action: "HOLD", reason: "unsafe_lock" };
    }

    return { action: "HOLD", reason: "uncertain_after_unsafe" };
  }

  return { action: "HOLD", reason: "pending" };
}

/**
 * Apply pipeline/content state updates after a non-DROP evaluation.
 */
export function applyBlurStateUpdates(
  state: Pick<
    FrameBlurState,
    "unsafeSeen" | "firstDecisionMade" | "safeStreak" | "unsafeLockUntil" | "nowMs"
  >,
  evaluation: BlurEvaluation
): {
  unsafeSeen: boolean;
  firstDecisionMade: boolean;
  safeStreak: number;
  unsafeLockUntil: number;
} {
  let unsafeSeen = state.unsafeSeen;
  let firstDecisionMade = state.firstDecisionMade;
  let safeStreak = state.safeStreak;
  let unsafeLockUntil = state.unsafeLockUntil;

  if (evaluation.action === "BLUR") {
    safeStreak = 0;
    firstDecisionMade = true;

    if (evaluation.reason === "unsafe") {
      unsafeSeen = true;
      unsafeLockUntil = state.nowMs + UNSAFE_LOCK_MS;
    }
  } else if (evaluation.action === "CLEAR") {
    unsafeSeen = false;
    safeStreak = 0;
    unsafeLockUntil = 0;
    firstDecisionMade = true;
  } else if (evaluation.action === "HOLD" && evaluation.reason === "building_safe_streak") {
    safeStreak += 1;
  }

  return { unsafeSeen, firstDecisionMade, safeStreak, unsafeLockUntil };
}

/**
 * One console line per blur decision (BLUR / CLEAR / DROP / HOLD).
 */
export function logBlurEvaluation(
  evaluation: BlurEvaluation,
  meta: {
    label: BlurLabel;
    score: number;
    nudityDetected: boolean;
    frame: number;
    gen: number;
    currentGen?: number;
  }
): void {
  const { label, score, nudityDetected, frame, gen, currentGen } = meta;

  if (evaluation.action === "DROP") {
    console.log(
      "[SafeView][DECISION] DROP reason=%s frame=%s gen=%s currentGen=%s",
      evaluation.reason,
      frame,
      gen,
      currentGen ?? gen
    );
    return;
  }

  if (evaluation.action === "HOLD") {
    console.log(
      "[SafeView][DECISION] HOLD reason=%s label=%s score=%s frame=%s gen=%s",
      evaluation.reason,
      label,
      score.toFixed(2),
      frame,
      gen
    );
    return;
  }

  console.log(
    "[SafeView][DECISION] score=%s nudity_detected=%s → %s (%s)",
    score.toFixed(2),
    nudityDetected,
    evaluation.action,
    evaluation.reason
  );
}
