// SafeView — imageNudityPolicy.ts
// Purpose: Website <img> nudity scan constants (separate from video sampling policy).

/** Blur website images when nudity confidence is at or above this (images only). */
export const IMAGE_NUDITY_BLUR_THRESHOLD = 0.5;

/** Show a small on-image badge with the last nudity score (debug/feedback). */
export const IMAGE_SHOW_SCORE_LABEL = true;

/** Reuse backend result for the same image URL/currentSrc (ms). */
export const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Max simultaneous image scans per tab (content script capture/send). */
export const MAX_CONCURRENT_IMAGE_SCANS = 10;

/** Max parallel /analyze-image calls for website images (service worker). */
export const MAX_CONCURRENT_IMAGE_BACKEND = 8;

/** Max new image scans queued per rescan/scroll wave (dense gallery pages). */
export const IMAGE_BATCH_PER_RESCAN = 80;

/** JPEG encode max width for website images. */
export const IMAGE_CAPTURE_MAX_WIDTH = 416;

/** JPEG quality for website image frames. */
export const IMAGE_JPEG_QUALITY = 0.75;

/** Skip images smaller than this in either dimension. */
export const IMAGE_MIN_DIMENSION_PX = 80;

/** Skip likely icons when both dimensions are below this. */
export const IMAGE_ICON_MAX_DIMENSION_PX = 120;

/** Max tracked <img> elements per page. */
export const MAX_TRACKED_IMAGES = 256;

/** Debounced DOM rescan interval (ms). */
export const IMAGE_SCAN_DEBOUNCE_MS = 400;

/** Periodic full rescan interval (ms). */
export const IMAGE_RESCAN_INTERVAL_MS = 800;

/** Debounced scan when user scrolls (ms). */
export const IMAGE_SCROLL_SCAN_DEBOUNCE_MS = 300;

/** Delayed rescan after bootstrap (ms). */
export const IMAGE_BOOTSTRAP_DELAY_MS = 1000;

/** Minimum ms between repeat scans of the same image (CLEAR only; BLUR is not rescanned). */
export const IMAGE_MIN_RESCAN_INTERVAL_MS = 1500;

/** Do not re-fetch or re-analyze an image URL after a settled scan (content + service worker). */
export const IMAGE_SKIP_RESCAN_WHEN_SETTLED = true;
