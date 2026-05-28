// SafeView — stableBlurPolicy.ts
// Purpose: Hysteresis, hold time, and sampling constants for classifier full-frame blur.

/** Consecutive safe frames required before CLEAR. */
export const SAFE_FRAMES_TO_CLEAR = 3;

/** Minimum time blur stays on after last unsafe detection (ms). */
export const MIN_BLUR_HOLD_MS = 1500;

/** Clear blur if no unsafe signal for this long (ms). */
export const BLUR_TTL_MS = 3000;

/** Frame analysis interval for active playback (ms). */
export const ANALYZE_INTERVAL_MS = 700;

/** Max canvas width before JPEG encode. */
export const MAX_FRAME_WIDTH = 320;

/** JPEG quality for frame transport. */
export const JPEG_QUALITY = 0.65;
