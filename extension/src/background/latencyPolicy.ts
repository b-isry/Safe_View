// SafeView — latencyPolicy.ts
// Purpose: Client blur latency policy (full-frame nudity + region/full violence).

/** Nudity classifier threshold (demo blur ON at ≥ 50% confidence). */
export const NUDITY_THRESHOLD = 0.5;

/** Violence detection threshold when backend action is BLUR. */
export const VIOLENCE_THRESHOLD = 0.5;

/** @deprecated Alias — use NUDITY_THRESHOLD for nudity decisions. */
export const UNSAFE_THRESHOLD = NUDITY_THRESHOLD;

/** Below this with detected === false: treat as safe. */
export const SAFE_THRESHOLD = 0.5;

/** Safe frames to clear preemptive blur on first trusted result. */
export const FIRST_SAFE_CLEAR_STREAK = 1;

/** Consecutive safe frames required to clear after unsafe (post lock). */
export const AFTER_UNSAFE_SAFE_CLEAR_STREAK = 2;

/** Minimum hold after unsafe before safe streak can clear (ms). */
export const UNSAFE_LOCK_MS = 2_000;

/** TTL: clear blur if no unsafe signal for this long (ms). */
export const UNSAFE_TTL_MS = 2_000;

/** Keep blur when backend analysis exceeds this duration (ms). */
export const BACKEND_TIMEOUT_MS = 4_000;

/** Mark in-flight analysis stale after this duration (ms). */
export const MAX_PENDING_ANALYSIS_MS = 5_000;

/** Active tab frame sampling interval (ms). */
export const SAMPLE_INTERVAL_MS = 700;

/** Max concurrent /analyze-image requests per video. */
export const MAX_IN_FLIGHT_PER_VIDEO = 1;

/** Adaptive throttle when JPEG encode exceeds this (ms). */
export const ENCODE_ADAPTIVE_THRESHOLD_MS = 500;

/** Pause capture loop when encode exceeds this (ms). */
export const ENCODE_PAUSE_THRESHOLD_MS = 1500;

/** Capture pause duration after severe encode stall (ms). */
export const ENCODE_PAUSE_DURATION_MS = 2000;

/** Adaptive sample interval while throttled (ms). */
export const SAMPLE_INTERVAL_THROTTLED_MS = 900;

/** Ping storage periodically so the MV3 service worker stays warm. */
export const SERVICE_WORKER_KEEPALIVE_MS = 20_000;

/** analyze-image fetch timeout (ms). */
export const ANALYZE_IMAGE_TIMEOUT_MS = 4_000;

/** Consecutive failures before marking backend offline. */
export const BACKEND_OFFLINE_FAILURE_STREAK = 3;
