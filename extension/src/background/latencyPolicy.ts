// SafeView — latencyPolicy.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Client-side blur latency policy (does not alter backend BR-01 detection).

/** Client blur floor — matches model calibration (backend BR-01 may still be 0.75). */
export const OPTIMISTIC_BLUR_SCORE_FLOOR = 0.65;

/** Hysteresis: CLEAR only after scores drop below this (avoids blur/clear fight at 0.65–0.70). */
export const OPTIMISTIC_CLEAR_SCORE_CEILING = 0.55;

/** Consecutive sub-ceiling frames required before sending CLEAR. */
export const OPTIMISTIC_CLEAR_STREAK = 2;

/** Ping storage periodically so the MV3 service worker stays warm. */
export const SERVICE_WORKER_KEEPALIVE_MS = 20_000;
