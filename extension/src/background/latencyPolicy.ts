// SafeView — latencyPolicy.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Nudity-only client blur latency policy (full-video; no region logic).

/** Below this confidence with detected === false: treat as safe and clear blur. */
export const SAFE_THRESHOLD = 0.5;

/** At or above this with detected === true: treat as unsafe and keep blur locked. */
export const UNSAFE_THRESHOLD = 0.72;

/** Safe frames to clear preemptive blur on first trusted result. */
export const FIRST_SAFE_CLEAR_STREAK = 1;

/** Safe frames required to clear after a confirmed unsafe scene (post lock). */
export const AFTER_UNSAFE_SAFE_CLEAR_STREAK = 10;

/** After real nudity, do not clear blur until this lock expires (ms). */
export const UNSAFE_LOCK_MS = 12_000;

/** Keep blur when backend analysis exceeds this duration (ms). */
export const BACKEND_TIMEOUT_MS = 1500;

/** Mark in-flight analysis stale after this duration (ms). */
export const MAX_PENDING_ANALYSIS_MS = 1800;

/** Active tab frame sampling interval (ms) — avoid CPU encode stalls. */
export const SAMPLE_INTERVAL_MS = 250;

/** Max concurrent /analyze-image requests per video. */
export const MAX_IN_FLIGHT_PER_VIDEO = 1;

/** Adaptive throttle when JPEG encode exceeds this (ms). */
export const ENCODE_ADAPTIVE_THRESHOLD_MS = 500;

/** Pause capture loop when encode exceeds this (ms). */
export const ENCODE_PAUSE_THRESHOLD_MS = 1500;

/** Capture pause duration after severe encode stall (ms). */
export const ENCODE_PAUSE_DURATION_MS = 2000;

/** Adaptive sample interval while throttled (ms). */
export const SAMPLE_INTERVAL_THROTTLED_MS = 500;

/** Ping storage periodically so the MV3 service worker stays warm. */
export const SERVICE_WORKER_KEEPALIVE_MS = 20_000;
