// SafeView — blurDecision.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: BLUR / CLEAR for nudity (gated), violence (YOLO), and kissing (romance classifier).

import {
  AFTER_UNSAFE_SAFE_CLEAR_STREAK,
  UNSAFE_LOCK_MS,
  UNSAFE_THRESHOLD,
} from "./latencyPolicy";

export type BlurLabel = "NSFW" | "SFW";

export type BlurDecisionAction = "BLUR" | "CLEAR";

export type BlurEvaluation =
  | { action: BlurDecisionAction; reason: string }
  | { action: "HOLD"; reason: string }
  | { action: "DROP"; reason: string };

/** Backend content gate from /analyze-image. */
export interface ContentTypeGate {
  is_animation?: boolean;
  is_real_human?: boolean;
  gate_reason?: string | null;
}

/**
 * Inputs for one frame's blur decision (after /analyze-image).
 * Blur only on real human nudity — not animation, person, face, or skin color.
 */
export interface FrameBlurState {
  /** Nudity confidence from /analyze-image (category=nudity). */
  score: number;
  /** Violence confidence from /analyze-image (category=violence). */
  violenceScore?: number;
  /** Kissing/romance confidence from /analyze-image (category=kissing). */
  kissingScore?: number;
  nudityDetected: boolean;
  violenceDetected?: boolean;
  kissingDetected?: boolean;
  backendAction: "BLUR" | "ALLOW" | null;
  violenceAction?: "BLUR" | "ALLOW" | null;
  kissingAction?: "BLUR" | "ALLOW" | null;
  contentType: ContentTypeGate | null;
  gateReason: string | null;
  frameSeq: number;
  lastProcessedFrameSeq: number;
  resultGeneration: number;
  currentGeneration: number;
  backendTrusted: boolean;
  modelLoaded: boolean;
  requestId: number;
  latestRequestId: number;
  unsafeSeen: boolean;
  firstDecisionMade: boolean;
  safeStreak: number;
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

  return confidence >= 0.5 ? "NSFW" : "SFW";
}

function isGateAllow(state: FrameBlurState): boolean {
  const gate = state.contentType;
  const reason = state.gateReason ?? gate?.gate_reason ?? null;

  if (
    state.violenceDetected ||
    state.violenceAction === "BLUR" ||
    state.kissingDetected ||
    state.kissingAction === "BLUR"
  ) {
    return false;
  }

  if (state.backendAction === "ALLOW") {
    return true;
  }

  if (!state.nudityDetected) {
    return true;
  }

  if (gate?.is_animation === true) {
    return true;
  }

  if (reason === "animation_skip" || reason === "no_real_human") {
    return true;
  }

  if (gate?.is_real_human === false) {
    return true;
  }

  return false;
}

function isRealHumanNudityBlur(state: FrameBlurState): boolean {
  const gate = state.contentType;

  if (state.backendAction !== "BLUR") {
    return false;
  }

  if (!state.nudityDetected) {
    return false;
  }

  if (state.score < UNSAFE_THRESHOLD) {
    return false;
  }

  if (gate?.is_animation === true) {
    return false;
  }

  if (gate?.is_real_human !== true) {
    return false;
  }

  return true;
}

function isViolenceBlur(state: FrameBlurState): boolean {
  if (state.violenceAction !== "BLUR") {
    return false;
  }

  if (!state.violenceDetected) {
    return false;
  }

  const violenceScore = state.violenceScore ?? 0;
  return violenceScore >= UNSAFE_THRESHOLD;
}

function isKissingBlur(state: FrameBlurState): boolean {
  if (state.kissingAction !== "BLUR") {
    return false;
  }

  if (!state.kissingDetected) {
    return false;
  }

  const kissingScore = state.kissingScore ?? 0;
  return kissingScore >= UNSAFE_THRESHOLD;
}

function shouldBlurFrame(state: FrameBlurState): boolean {
  return (
    isRealHumanNudityBlur(state) ||
    isViolenceBlur(state) ||
    isKissingBlur(state)
  );
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

  if (shouldBlurFrame(state)) {
    const reason = isKissingBlur(state)
      ? "kissing"
      : isViolenceBlur(state)
        ? "violence"
        : "real_human_nudity";
    return { action: "BLUR", reason };
  }

  if (isGateAllow(state)) {
    if (!state.unsafeSeen) {
      const reason =
        state.gateReason === "animation_skip"
          ? "animation_skip"
          : state.gateReason === "no_real_human"
            ? "no_real_human"
            : state.gateReason === "real_human_safe"
              ? "real_human_safe"
              : "first_safe";
      return { action: "CLEAR", reason };
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

  if (!state.firstDecisionMade) {
    return { action: "HOLD", reason: "precheck" };
  }

  if (!state.unsafeSeen) {
    return { action: "HOLD", reason: "pending" };
  }

  if (state.nowMs < state.unsafeLockUntil) {
    return { action: "HOLD", reason: "unsafe_lock" };
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
    unsafeSeen = true;
    unsafeLockUntil = state.nowMs + UNSAFE_LOCK_MS;
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
    violenceDetected?: boolean;
    kissingDetected?: boolean;
    gateReason: string | null;
    frame: number;
    gen: number;
    currentGen?: number;
  }
): void {
  const {
    label,
    score,
    nudityDetected,
    violenceDetected,
    kissingDetected,
    gateReason,
    frame,
    gen,
    currentGen,
  } = meta;

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
      "[SafeView][DECISION] HOLD reason=%s gate=%s label=%s score=%s frame=%s gen=%s",
      evaluation.reason,
      gateReason ?? "-",
      label,
      score.toFixed(2),
      frame,
      gen
    );
    return;
  }

  console.log(
    "[SafeView][DECISION] score=%s nudity=%s violence=%s kissing=%s gate=%s → %s (%s)",
    score.toFixed(2),
    nudityDetected,
    violenceDetected ?? false,
    kissingDetected ?? false,
    gateReason ?? "-",
    evaluation.action,
    evaluation.reason
  );
}
