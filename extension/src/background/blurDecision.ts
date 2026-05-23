// SafeView — blurDecision.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Single state machine for BLUR / CLEAR decisions (no scattered blur mutations).

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

  return confidence >= 0.5 ? "NSFW" : "SFW";
}

/**
 * Sole blur decision function — all BLUR/CLEAR commands must follow this.
 *
 * Rules:
 * - label NSFW and score >= threshold → BLUR
 * - label SFW → CLEAR (score ignored)
 * - label NSFW and score < threshold → CLEAR
 * - inflight after recent unsafe → HOLD (no re-blur)
 * - stale generation or frame sequence → DROP
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

  if (
    state.analysisInFlight &&
    state.lastUnsafe &&
    state.label === "NSFW" &&
    state.score >= state.threshold
  ) {
    return { action: "HOLD", reason: "inflight_after_unsafe" };
  }

  if (state.label === "SFW") {
    return { action: "CLEAR", reason: "SFW" };
  }

  if (state.score >= state.threshold) {
    return { action: "BLUR", reason: "NSFW_confirmed" };
  }

  return { action: "CLEAR", reason: "NSFW_below_threshold" };
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
