// SafeView — latencyPolicy.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Nudity-only client blur latency policy (full-video blur; no region logic).

/** Below this confidence: treat as safe and clear blur. */
export const SAFE_THRESHOLD = 0.5;

/** At or above this with detected: treat as unsafe and keep blur. */
export const UNSAFE_THRESHOLD = 0.65;

/** Uncertain band frames before clearing (face/person/skin-tone false positives). */
export const UNCERTAIN_MAX_FRAMES = 2;

/** Blur when nudity is confirmed at or above this score. */
export const OPTIMISTIC_BLUR_SCORE_FLOOR = 0.65;

/** Consecutive safe frames required before CLEAR (default path). */
export const OPTIMISTIC_CLEAR_STREAK = 1;

/** Safe frames needed to clear preemptive blur on first trusted result. */
export const FIRST_SAFE_CLEAR_STREAK = 1;

/** Safe frames needed to clear after a prior unsafe blur. */
export const AFTER_UNSAFE_SAFE_CLEAR_STREAK = 2;

/** Ping storage periodically so the MV3 service worker stays warm. */
export const SERVICE_WORKER_KEEPALIVE_MS = 20_000;
