// SafeView — blurDecision.ts

// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome

// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC

// Purpose: Nudity-only BLUR / CLEAR state machine (full-video blur; no region logic).



import {

  FIRST_SAFE_CLEAR_STREAK,

  NUDITY_BLUR_THRESHOLD,

  SAFE_CONFIRMATIONS_TO_CLEAR,

  SAFE_THRESHOLD,

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

  frameSeq: number;

  lastProcessedFrameSeq: number;

  resultGeneration: number;

  currentGeneration: number;

  backendTrusted: boolean;

  firstDecisionMade: boolean;

  safeStreak: number;

  nudityDetected: boolean;

  nudityAction: "BLUR" | "ALLOW" | null;

  confirmedUnsafe: boolean;

}



/**

 * Map backend / analyze-image fields to NSFW | SFW.

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



function isUnsafeFrame(state: FrameBlurState): boolean {

  if (!state.backendTrusted) {

    return false;

  }



  return (

    state.nudityDetected === true &&

    state.nudityAction === "BLUR" &&

    state.score >= NUDITY_BLUR_THRESHOLD

  );

}



function isSafeFrame(state: FrameBlurState): boolean {

  if (!state.backendTrusted) {

    return false;

  }



  if (state.nudityDetected === false || state.nudityAction === "ALLOW") {

    return true;

  }



  return state.label === "SFW" && state.score < SAFE_THRESHOLD;

}



function requiredSafeClearStreak(confirmedUnsafe: boolean): number {

  return confirmedUnsafe ? SAFE_CONFIRMATIONS_TO_CLEAR : FIRST_SAFE_CLEAR_STREAK;

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



  if (!state.backendTrusted) {

    return { action: "HOLD", reason: "backend_untrusted" };

  }



  if (isUnsafeFrame(state)) {

    return { action: "BLUR", reason: "confirmed-nudity" };

  }



  if (isSafeFrame(state)) {

    const requiredStreak = requiredSafeClearStreak(state.confirmedUnsafe);

    const nextStreak = state.safeStreak + 1;

    if (!state.firstDecisionMade || nextStreak >= requiredStreak) {

      return {

        action: "CLEAR",

        reason: state.confirmedUnsafe ? "confirmed-safe-after-unsafe" : "safe-frame",

      };

    }

    return { action: "HOLD", reason: "building_safe_streak" };

  }



  if (state.confirmedUnsafe) {

    return { action: "HOLD", reason: "holding_confirmed_unsafe" };

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

    detected?: boolean;

    action?: string | null;

  }

): void {

  const { label, score, frame, gen, currentGen, detected, action } = meta;



  if (evaluation.action === "DROP") {

    console.log(

      "[SafeView][Pipeline] ignored result reason=%s frame=%s gen=%s currentGen=%s",

      evaluation.reason,

      frame,

      gen,

      currentGen ?? gen

    );

    return;

  }



  if (evaluation.action === "HOLD") {

    console.log(

      "[SafeView][Pipeline] decision=HOLD reason=%s label=%s score=%s detected=%s action=%s frame=%s",

      evaluation.reason,

      label,

      score.toFixed(2),

      detected === true ? "true" : "false",

      action ?? "?",

      frame

    );

    return;

  }



  if (evaluation.action === "BLUR") {

    console.log(

      "[SafeView][Pipeline] decision=BLUR reason=%s confidence=%s",

      evaluation.reason,

      score.toFixed(2)

    );

    return;

  }



  console.log(

    "[SafeView][Pipeline] decision=ALLOW reason=%s confidence=%s",

    evaluation.reason,

    score.toFixed(2)

  );

}

