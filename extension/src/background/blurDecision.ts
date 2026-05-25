// SafeView — blurDecision.ts
// Purpose: BLUR / CLEAR for nudity (full-frame) and violence (region or full-frame fallback).

import type { AnalyzeImageResponse, DetectionBox } from "../shared/apiTypes";
import {
  createStableBlurState,
  evaluateStableDemoBlur,
  type StableBlurState,
} from "./stableBlurDecision";
import {
  AFTER_UNSAFE_SAFE_CLEAR_STREAK,
  NUDITY_THRESHOLD,
  UNSAFE_LOCK_MS,
  UNSAFE_TTL_MS,
  VIOLENCE_THRESHOLD,
} from "./latencyPolicy";

export type BlurLabel = "NSFW" | "SFW";

export type BlurDecisionAction = "BLUR" | "CLEAR" | "KEEP";

export type BlurMode = "none" | "full" | "regions";

export type BlurEvaluation =
  | { action: BlurDecisionAction; reason: string; blurMode?: BlurMode; detections?: DetectionBox[] }
  | { action: "HOLD"; reason: string }
  | { action: "DROP"; reason: string };

/** @deprecated Use ContentTypeGate from apiTypes — kept for tests. */
export interface ContentTypeGate {
  is_animation?: boolean;
  is_real_human?: boolean;
  gate_reason?: string | null;
}

export interface FrameBlurState {
  score: number;
  violenceScore?: number;
  nudityDetected: boolean;
  violenceDetected?: boolean;
  nudityAction: "BLUR" | "ALLOW" | null;
  violenceAction?: "BLUR" | "ALLOW" | null;
  violenceDetections?: DetectionBox[];
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
  lastUnsafeAt: number;
  nowMs: number;
}

/** Demo / production helper — true when classifier says blur this frame. */
export function shouldBlurFrame(
  response: Pick<
    AnalyzeImageResponse,
    "model_loaded" | "action" | "detected" | "confidence"
  >,
  threshold: number = NUDITY_THRESHOLD
): boolean {
  return shouldBlurResponse(response, threshold);
}

export function shouldBlurResponse(
  response: Pick<
    AnalyzeImageResponse,
    "model_loaded" | "action" | "detected" | "confidence"
  >,
  threshold: number
): boolean {
  if (!response.model_loaded) {
    return false;
  }
  if (response.action !== "BLUR") {
    return false;
  }
  if (!response.detected) {
    return false;
  }
  return response.confidence >= threshold;
}

function violenceHasBoxes(detections: DetectionBox[] | undefined): boolean {
  if (!detections?.length) {
    return false;
  }
  return detections.some(
    (entry) =>
      Array.isArray(entry.box) &&
      entry.box.length === 4 &&
      entry.box[2] > entry.box[0] &&
      entry.box[3] > entry.box[1]
  );
}

function resolveBlurMode(state: FrameBlurState): {
  blur: boolean;
  mode: BlurMode;
  detections: DetectionBox[];
  reason: string;
} {
  const nudityBlur =
    state.nudityAction === "BLUR" &&
    state.nudityDetected &&
    state.score >= NUDITY_THRESHOLD;

  if (nudityBlur) {
    return { blur: true, mode: "full", detections: [], reason: "nudity_full" };
  }

  const violenceBlur =
    state.violenceAction === "BLUR" &&
    state.violenceDetected === true &&
    (state.violenceScore ?? 0) >= VIOLENCE_THRESHOLD;

  if (violenceBlur) {
    const detections = state.violenceDetections ?? [];
    if (violenceHasBoxes(detections)) {
      return {
        blur: true,
        mode: "regions",
        detections,
        reason: "violence_regions",
      };
    }
    return { blur: true, mode: "full", detections: [], reason: "violence_full_fallback" };
  }

  return { blur: false, mode: "none", detections: [], reason: "safe" };
}

export function normalizeBlurLabel(
  label: string | undefined,
  confidence: number
): BlurLabel {
  if (label === "NSFW" || label === "SFW") {
    return label;
  }
  return confidence >= 0.5 ? "NSFW" : "SFW";
}

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
    if (state.unsafeSeen && state.nowMs - state.lastUnsafeAt > UNSAFE_TTL_MS) {
      return { action: "CLEAR", reason: "backend_disconnect_ttl" };
    }
    if (state.firstDecisionMade && !state.unsafeSeen) {
      return { action: "HOLD", reason: "backend_retry" };
    }
    return { action: "HOLD", reason: "backend_untrusted" };
  }

  if (!state.modelLoaded) {
    if (state.unsafeSeen && state.nowMs - state.lastUnsafeAt > UNSAFE_TTL_MS) {
      return { action: "CLEAR", reason: "model_unavailable_ttl" };
    }
    return { action: "HOLD", reason: "model_not_loaded" };
  }

  const resolved = resolveBlurMode(state);

  if (resolved.blur) {
    return {
      action: "BLUR",
      reason: resolved.reason,
      blurMode: resolved.mode,
      detections: resolved.detections,
    };
  }

  if (!state.unsafeSeen) {
    return { action: "CLEAR", reason: "first_safe" };
  }

  if (state.nowMs < state.unsafeLockUntil) {
    return { action: "HOLD", reason: "unsafe_lock" };
  }

  if (state.nowMs - state.lastUnsafeAt > UNSAFE_TTL_MS) {
    return { action: "CLEAR", reason: "unsafe_ttl_expired" };
  }

  const nextStreak = state.safeStreak + 1;
  if (nextStreak >= AFTER_UNSAFE_SAFE_CLEAR_STREAK) {
    return { action: "CLEAR", reason: "safe_after_unsafe" };
  }

  return { action: "HOLD", reason: "building_safe_streak" };
}

export function applyBlurStateUpdates(
  state: Pick<
    FrameBlurState,
    | "unsafeSeen"
    | "firstDecisionMade"
    | "safeStreak"
    | "unsafeLockUntil"
    | "lastUnsafeAt"
    | "nowMs"
  >,
  evaluation: BlurEvaluation
): {
  unsafeSeen: boolean;
  firstDecisionMade: boolean;
  safeStreak: number;
  unsafeLockUntil: number;
  lastUnsafeAt: number;
} {
  let unsafeSeen = state.unsafeSeen;
  let firstDecisionMade = state.firstDecisionMade;
  let safeStreak = state.safeStreak;
  let unsafeLockUntil = state.unsafeLockUntil;
  let lastUnsafeAt = state.lastUnsafeAt;

  if (evaluation.action === "BLUR") {
    safeStreak = 0;
    firstDecisionMade = true;
    unsafeSeen = true;
    lastUnsafeAt = state.nowMs;
    unsafeLockUntil = state.nowMs + UNSAFE_LOCK_MS;
  } else if (evaluation.action === "CLEAR") {
    unsafeSeen = false;
    safeStreak = 0;
    unsafeLockUntil = 0;
    lastUnsafeAt = 0;
    firstDecisionMade = true;
  } else if (evaluation.action === "HOLD" && evaluation.reason === "building_safe_streak") {
    safeStreak += 1;
  }

  return { unsafeSeen, firstDecisionMade, safeStreak, unsafeLockUntil, lastUnsafeAt };
}

export interface DemoBlurSwitchInput {
  response: Pick<
    AnalyzeImageResponse,
    "model_loaded" | "action" | "detected" | "confidence"
  >;
  frameSeq: number;
  lastProcessedFrameSeq: number;
  requestId: number;
  latestRequestId: number;
  resultGeneration: number;
  currentGeneration: number;
  backendTrusted: boolean;
}

/**
 * Stable demo classifier blur (hysteresis, hold, safe streak). Delegates to stableBlurDecision.
 */
export type DemoBlurEvaluation = BlurEvaluation & { stableState?: StableBlurState };

export function evaluateDemoBlurSwitch(
  input: DemoBlurSwitchInput & {
    stableState?: StableBlurState;
    nowMs?: number;
  }
): DemoBlurEvaluation {
  const baseState = input.stableState ?? createStableBlurState();
  const result = evaluateStableDemoBlur({
    response: input.response,
    state: baseState,
    frameSeq: input.frameSeq,
    lastProcessedFrameSeq: input.lastProcessedFrameSeq,
    requestId: input.requestId,
    latestRequestId: input.latestRequestId,
    resultGeneration: input.resultGeneration,
    currentGeneration: input.currentGeneration,
    backendTrusted: input.backendTrusted,
    nowMs: input.nowMs,
  });

  if ("dropped" in result) {
    return { action: "DROP", reason: result.reason };
  }

  const evaluation: DemoBlurEvaluation = {
    stableState: result.state,
    action: result.command,
    reason: result.reason,
  };

  if (result.command === "BLUR") {
    return {
      ...evaluation,
      blurMode: "full",
      detections: [],
    };
  }

  return evaluation;
}

export function logBlurEvaluation(
  evaluation: BlurEvaluation,
  meta: {
    label: BlurLabel;
    score: number;
    nudityDetected: boolean;
    violenceDetected?: boolean;
    gateReason: string | null;
    frame: number;
    gen: number;
    currentGen?: number;
  }
): void {
  const { label, score, nudityDetected, violenceDetected, gateReason, frame, gen, currentGen } =
    meta;

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

  if (evaluation.action === "HOLD" || evaluation.action === "KEEP") {
    console.log(
      "[SafeView][DECISION] %s reason=%s gate=%s label=%s score=%s frame=%s gen=%s",
      evaluation.action,
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
    "[SafeView][DECISION] score=%s nudity=%s violence=%s gate=%s → %s (%s) mode=%s",
    score.toFixed(2),
    nudityDetected,
    violenceDetected ?? false,
    gateReason ?? "-",
    evaluation.action,
    evaluation.reason,
    evaluation.action === "BLUR" ? evaluation.blurMode ?? "full" : "none"
  );
}
