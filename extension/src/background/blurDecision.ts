// SafeView — blurDecision.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Nudity-only BLUR / CLEAR state machine (full-video; no region logic).

import {
  AFTER_UNSAFE_SAFE_CLEAR_STREAK,
  FIRST_SAFE_CLEAR_STREAK,
  SAFE_THRESHOLD,
  UNCERTAIN_MAX_FRAMES,
  UNSAFE_THRESHOLD,
} from "./latencyPolicy";

export type BlurLabel = "NSFW" | "SFW";

export type BlurDecisionAction = "BLUR" | "CLEAR";

export type BlurEvaluation =
  | { action: BlurDecisionAction; reason: string }
  | { action: "HOLD"; reason: string }
  | { action: "DROP"; reason: string };

/**
 * Inputs for one frame's blur decision (after backend inference).
 */
export interface FrameBlurState {
  label: BlurLabel;
  score: number;
  threshold: number;
  frameSeq: number;
  lastProcessedFrameSeq: number;
  resultGeneration: number;
  currentGeneration: number;
  analysisInFlight: boolean;
  lastUnsafe: boolean;
  /** False when backend is offline, timed out, or returned an error. */
  backendTrusted: boolean;
  /** True after the first trusted backend result was processed. */
  firstDecisionMade: boolean;
  /** Consecutive clearly-safe frames since last unsafe / uncertain. */
  safeStreak: number;
  /** Consecutive uncertain-band frames without high nudity confidence. */
  uncertainStreak: number;
  /** Backend nudity detected flag for this frame. */
  nudityDetected: boolean;
}

/**
 * Map backend / analyze-image fields to NSFW | SFW.
 *
 * @param label - Optional label from backend.
 * @param confidence - Model score (P(NSFW) or equivalent).
 * @returns Normalized blur label.
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

/**
 * True when confidence is in the uncertain band (not clearly safe or unsafe).
 */
function isUncertainBand(score: number): boolean {
  return score >= SAFE_THRESHOLD && score < UNSAFE_THRESHOLD;
}

/**
 * Required consecutive safe frames before CLEAR.
 */
function requiredSafeClearStreak(lastUnsafe: boolean): number {
  return lastUnsafe ? AFTER_UNSAFE_SAFE_CLEAR_STREAK : FIRST_SAFE_CLEAR_STREAK;
}

/**
 * Sole blur decision function — all BLUR/CLEAR commands must follow this.
 *
 * Nudity-only rules:
 * - confidence < SAFE_THRESHOLD → safe (CLEAR with streak)
 * - detected && confidence >= UNSAFE_THRESHOLD → unsafe (BLUR)
 * - uncertain band → HOLD; CLEAR after UNCERTAIN_MAX_FRAMES without high nudity
 * - backend untrusted → HOLD (fail closed)
 *
 * @param state - Frame and pipeline context.
 * @returns BLUR, CLEAR, HOLD, or DROP with a logging reason.
 */
export function evaluateBlurState(state: FrameBlurState): BlurEvaluation {
  if (state.resultGeneration !== state.currentGeneration) {
    return { action: "DROP", reason: "stale_gen" };
  }

  if (state.frameSeq < state.lastProcessedFrameSeq) {
    return { action: "DROP", reason: "stale_frame" };
  }

  if (!state.backendTrusted) {
    return { action: "HOLD", reason: "backend_untrusted" };
  }

  if (
    state.analysisInFlight &&
    state.lastUnsafe &&
    state.nudityDetected &&
    state.score >= UNSAFE_THRESHOLD
  ) {
    return { action: "HOLD", reason: "inflight_after_unsafe" };
  }

  if (state.nudityDetected && state.score >= UNSAFE_THRESHOLD) {
    return { action: "BLUR", reason: "unsafe" };
  }

  if (state.label === "SFW") {
    const requiredStreak = requiredSafeClearStreak(state.lastUnsafe);
    const nextStreak = state.safeStreak + 1;
    if (!state.firstDecisionMade || nextStreak >= requiredStreak) {
      return {
        action: "CLEAR",
        reason: state.lastUnsafe ? "safe_after_unsafe" : "safe",
      };
    }
    return { action: "HOLD", reason: "building_safe_streak" };
  }

  if (state.score < SAFE_THRESHOLD) {
    const requiredStreak = requiredSafeClearStreak(state.lastUnsafe);
    const nextStreak = state.safeStreak + 1;
    if (!state.firstDecisionMade || nextStreak >= requiredStreak) {
      return { action: "CLEAR", reason: state.lastUnsafe ? "safe_after_unsafe" : "safe" };
    }
    return { action: "HOLD", reason: "building_safe_streak" };
  }

  if (isUncertainBand(state.score)) {
    const nextUncertain = state.uncertainStreak + 1;
    if (nextUncertain >= UNCERTAIN_MAX_FRAMES) {
      return { action: "CLEAR", reason: "uncertain_cleared" };
    }
    return { action: "HOLD", reason: "uncertain" };
  }

  return { action: "HOLD", reason: "pending" };
}

/**
 * One console line per blur decision (BLUR / CLEAR / DROP / HOLD).
 */
export function logBlurEvaluation(
  evaluation: BlurEvaluation,
  meta: {
    label: BlurLabel;
    score: number;
    frame: number;
    gen: number;
    currentGen?: number;
  }
): void {
  const { label, score, frame, gen, currentGen } = meta;

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
    "[SafeView][DECISION] label=%s score=%s → %s",
    label,
    score.toFixed(2),
    evaluation.action
  );
}
