// SafeView — latencyPolicy.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Nudity-only client blur latency policy (full-video; no region logic).

/** Below this confidence with detected === false: treat as safe and clear blur. */
export const SAFE_THRESHOLD = 0.5;

/** At or above this with detected === true: treat as unsafe and keep blur locked. */
export const UNSAFE_THRESHOLD = 0.72;

/** At or above this: preemptively blur while awaiting confirmation. */
export const SUSPICIOUS_THRESHOLD = 0.62;

/** Safe frames to clear preemptive blur on first trusted result. */
export const FIRST_SAFE_CLEAR_STREAK = 1;

/** Safe frames required to clear after a confirmed unsafe scene (post lock). */
export const AFTER_UNSAFE_SAFE_CLEAR_STREAK = 15;

/** After real nudity, do not clear blur until this lock expires (ms). */
export const UNSAFE_LOCK_MS = 12_000;

/** Max duration for scene-change preemptive blur before safe clear (ms). */
export const SCENE_CHANGE_TEMP_BLUR_MS = 500;

/** Keep blur when backend analysis exceeds this duration (ms). */
export const BACKEND_TIMEOUT_MS = 1000;

/** Mark in-flight analysis stale after this duration (ms). */
export const MAX_PENDING_ANALYSIS_MS = 1200;

/** Active tab frame sampling interval (ms). */
export const SAMPLE_INTERVAL_MS = 40;

/** Ping storage periodically so the MV3 service worker stays warm. */
export const SERVICE_WORKER_KEEPALIVE_MS = 20_000;
