// SafeView — latencyPolicy.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Client-side blur latency policy (does not alter backend BR-01 detection).

/** Apply blur early when score reaches this (backend may still return ALLOW). */
export const OPTIMISTIC_BLUR_SCORE_FLOOR = 0.65;

/** Consecutive sub-threshold frames required before sending CLEAR. */
export const OPTIMISTIC_CLEAR_STREAK = 2;

/** Ping storage periodically so the MV3 service worker stays warm. */
export const SERVICE_WORKER_KEEPALIVE_MS = 20_000;
