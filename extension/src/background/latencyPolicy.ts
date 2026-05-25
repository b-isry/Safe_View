// SafeView — latencyPolicy.ts

// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome

// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC

// Purpose: Client blur latency policy for nudity, violence, and kissing (full-video blur).



/** Below this confidence: treat as clearly safe for CLEAR streaks. */

export const SAFE_THRESHOLD = 0.5;



/** Backend + client: blur when any enabled category meets this floor. */

export const CONTENT_BLUR_THRESHOLD = 0.85;

/** @deprecated Use CONTENT_BLUR_THRESHOLD */
export const NUDITY_BLUR_THRESHOLD = CONTENT_BLUR_THRESHOLD;



/** Immediate blur without waiting for extra confirmations. */

export const NUDITY_IMMEDIATE_BLUR_THRESHOLD = 0.9;



/** @deprecated Use NUDITY_BLUR_THRESHOLD — kept for legacy imports/tests. */

export const UNSAFE_THRESHOLD = NUDITY_BLUR_THRESHOLD;



/** Consecutive unsafe frames required (1 while fixing missed blurs). */

export const UNSAFE_CONFIRMATIONS_REQUIRED = 1;



/** Consecutive fresh safe frames before CLEAR after confirmed unsafe. */

export const SAFE_CONFIRMATIONS_TO_CLEAR = 2;



/** @deprecated Use SAFE_CONFIRMATIONS_TO_CLEAR. */

export const AFTER_UNSAFE_SAFE_CLEAR_STREAK = SAFE_CONFIRMATIONS_TO_CLEAR;



/** First safe result clears startup blur on normal videos. */

export const FIRST_SAFE_CLEAR_STREAK = 1;



/** Minimum hold after confirmed unsafe before safe CLEAR can apply (ms). */

export const MIN_CONFIRMED_UNSAFE_HOLD_MS = 500;



/** Max wall-clock drift (sec) from capture to applying an unsafe BLUR result. */

export const MAX_APPLY_TIME_DRIFT_SEC = 0.75;



/** Response older than this (ms) from capture is stale. */

export const STALE_RESPONSE_MS = 1500;



/** Startup preemptive blur duration when backend has not confirmed unsafe (ms). */

export const STARTUP_BLUR_MS = 1000;



/** Animation/cartoon/anime skip threshold. */

export const ANIMATION_SKIP_THRESHOLD = 0.8;



/** Ping storage periodically so the MV3 service worker stays warm. */

export const SERVICE_WORKER_KEEPALIVE_MS = 20_000;

