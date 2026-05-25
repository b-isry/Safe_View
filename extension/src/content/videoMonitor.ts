// SafeView — videoMonitor.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Find <video> elements via MutationObserver and sample frames for nudity detection.
// CSP-safe: native DOM only — no injected <script> tags or page-context hooks.

import {
  isNudityProtectionActive,
  loadSettings,
  SETTINGS_STORAGE_KEY,
  type SafeViewSettings,
} from "../background/businessRules";
import { MESSAGE_ACTION_SETTINGS_UPDATED } from "../shared/settingsMessages";
import {
  onVideoTrackedForSpeakerSuppression,
  prepareVideoCrossOrigin,
  startSubtitleMonitor,
  stopSubtitleMonitor,
} from "./audioMonitor";
import {
  applyImmediateLocalBlur,
  clearAllFullVideoBlurs,
  clearImmediateLocalBlur,
  isFullVideoBlurred,
} from "./fullVideoBlur";
import { NUDITY_BLUR_THRESHOLD } from "../background/latencyPolicy";
import {
  onYouTubeWatchIdBoundary,
  seedYouTubeWatchVideoId,
} from "./pipelineNavigation";

/** Consecutive safe frames before clearing confirmed unsafe blur. */
const SAFE_CONFIRMATIONS_TO_CLEAR = 2;

/** Minimum hold after confirmed unsafe before safe clear (ms). */
const MIN_CONFIRMED_UNSAFE_HOLD_MS = 500;

/** Min currentTime delta (sec) to treat playback as progressing. */
const VIDEO_TIME_PROGRESS_MIN_SEC = 0.03;

/** Scene jump threshold (sec) for immediate rescan. */
const SCENE_CHANGE_TIME_JUMP_SEC = 0.35;

/** Active visible tab sampling gate (ms) — balance latency vs backend load. */
export const SAMPLE_INTERVAL_MS = 220;

/** @deprecated Alias for SAMPLE_INTERVAL_MS — kept for tests/imports. */
export const SAMPLE_INTERVAL_ACTIVE_MS = SAMPLE_INTERVAL_MS;

/** Fast scan during startup safety window. */
export const STARTUP_SCAN_INTERVAL_MS = 100;

/** Scan while confirmed unsafe (live middle detection). */
export const UNSAFE_MONITORING_INTERVAL_MS = 150;

/** @deprecated Use UNSAFE_MONITORING_INTERVAL_MS */
export const BLURRED_SCAN_INTERVAL_MS = UNSAFE_MONITORING_INTERVAL_MS;

/** Continuous scan while video is clear (safe monitoring). */
export const SAFE_MONITORING_INTERVAL_MS = 200;

/** @deprecated Use SAFE_MONITORING_INTERVAL_MS */
export const SAFE_SCAN_INTERVAL_MS = SAFE_MONITORING_INTERVAL_MS;

/** Paused video: lower sampling rate. */
export const SAMPLE_INTERVAL_PAUSED_MS = 2000;

/** Hidden document tab: lower sampling rate. */
export const SAMPLE_INTERVAL_HIDDEN_MS = 2000;

/** Warn when JPEG encode exceeds this (ms). */
export const ENCODE_STALL_WARN_MS = 250;

/** MIME type passed to canvas.toBlob for frame upload. */
export const FRAME_MIME_TYPE = "image/jpeg";

/** @deprecated Use FRAME_MIME_TYPE */
const JPEG_MIME_TYPE = FRAME_MIME_TYPE;

/** JPEG quality for canvas.toBlob (model resizes to 224×224). */
export const JPEG_QUALITY = 0.38;

/** Max canvas width before JPEG encode. */
export const CAPTURE_MAX_WIDTH_PX = 160;

/** Fast encode after slow frames. */
export const FAST_MODE_FRAME_WIDTH = 128;
export const FAST_MODE_QUALITY = 0.32;

/** Allow slightly larger frames when accuracy needs a boost. */
export const CAPTURE_MAX_WIDTH_ACCURACY_PX = 192;

/** One in-flight backend request timeout (ms). */
export const REQUEST_TIMEOUT_MS = 800;

/** Max age before a pending request is abandoned (ms). */
export const MAX_PENDING_ANALYSIS_MS = 900;

/** Startup preemptive blur enabled for primary playing videos. */
export const STARTUP_TEMP_BLUR_ENABLED = true;

/** Startup preemptive blur duration (ms). */
export const STARTUP_TEMP_BLUR_MAX_MS = 1000;

/** @deprecated Use STARTUP_TEMP_BLUR_MAX_MS */
export const STARTUP_BLUR_MS = STARTUP_TEMP_BLUR_MAX_MS;

/** Backend analysis timeout — does not mark unsafe; startup blur may expire. */
export const BACKEND_TIMEOUT_MS = 800;

/** Animation/cartoon/anime skip threshold from backend. */
export const ANIMATION_SKIP_THRESHOLD = 0.8;

/** @deprecated Use ANIMATION_SKIP_THRESHOLD */
export const ANIMATION_SKIP_SCORE = ANIMATION_SKIP_THRESHOLD;

/** Delay before the first frame sample after registration (0 = immediate). */
export const FIRST_FRAME_ANALYSIS_DELAY_MS = 0;

/** Debounce immediate scan triggers (ms) — startup uses 0. */
export const IMMEDIATE_SCAN_DEBOUNCE_MS = 0;

/** Max video-time drift (sec) before ignoring a backend result. */
export const MAX_APPLY_TIME_DRIFT_SEC = 0.75;

/** Wall-clock age (ms) after which a response is stale. */
export const STALE_RESPONSE_MS = 1500;

/** Fast encode mode scan count before reverting to normal. */
export const FAST_MODE_DURATION_SCANS = 10;

/** Retry interval when the first sample has no decoded frame yet (ms). */
const FIRST_SAMPLE_RETRY_MS = 80;

/** Per-video debounced immediate scan timers. */
const immediateScanTimers = new WeakMap<HTMLVideoElement, number>();


/** Reject near-black frames (transitions, fades, failed decode). */
const MIN_FRAME_LUMINANCE = 12;

/** chrome.runtime message action sent to the service worker with a frame blob. */
export const MESSAGE_ACTION_FRAME_SAMPLE = "FRAME_SAMPLE";

/** Service worker → content script: one frame analysis cycle finished. */
export const MESSAGE_ACTION_FRAME_ANALYSIS_DONE = "FRAME_ANALYSIS_DONE";

/** Minimum layout size (px) for a video to count as the visible player. */
const MIN_VISIBLE_LAYOUT_PX = 200;

/** data-* marker: video registered for SafeView monitoring. */
const SAFE_VIEW_TRACKED_DATASET = "safeViewTracked";

/** Global bump invalidates all in-flight capture / rVFC chains (YouTube navigation). */
let globalCaptureGeneration = 0;

/** Number of overlapping canvas encodes (diagnostic; expect 0 or 1). */
let activeCaptureCount = 0;

/** Video element currently allowed to run the capture loop (only one). */
let primaryCaptureVideo: HTMLVideoElement | null = null;

/** High-level safety state for one video element. */
export type VideoSafetyState =
  | "STARTUP_CHECKING"
  | "SAFE_MONITORING"
  | "UNSAFE_BLURRED"
  | "ENDED";

/**
 * Per-video backend analysis tracking (frame queue protection).
 */
export type VideoAnalysisState = {
  safetyState: VideoSafetyState;
  isAnalyzing: boolean;
  lastAnalysisStartedAt: number;
  requestId: number;
  sessionId: number;
  firstDecisionMade: boolean;
  confirmedUnsafe: boolean;
  startupBlurActive: boolean;
  startupBlurExpiresAt: number;
  startupWindowStarted: boolean;
  isBlurred: boolean;
  safeStreak: number;
  unsafeStreak: number;
  captureInProgress: boolean;
  encodeInProgress: boolean;
  pendingRequest: boolean;
  pendingRequestStartedAt: number;
  pendingCapturedVideoTime: number;
  lastCapturedVideoTime: number;
  lastResponseAt: number;
  lastBlurAppliedAt: number;
  unsafeLockUntil: number;
  scanLoopRunning: boolean;
  startupBlurTimer: BrowserTimerId | null;
  fastEncodeMode: boolean;
  fastEncodeScansRemaining: number;
  /** Force one analysis even when currentTime unchanged (scene change). */
  forceNextScan: boolean;
};

/**
 * Per-video sampling state stored in the WeakMap.
 */
export interface VideoTrackState {
  /** Stable id for messaging between content script and service worker. */
  videoId: number;
  /** Monotonic timestamp of the last successful sample (performance.now()). */
  lastSampleAt: number;
  /** Active interval handle, or null when using rVFC or stopped. */
  intervalId: BrowserTimerId | null;
  /** True while an async capture is in flight for this video. */
  isCapturing: boolean;
  /** Last video.currentTime sent — skips duplicate frames at the same timestamp. */
  lastSampledTime: number;
  /** True when sampling uses requestVideoFrameCallback instead of setInterval. */
  usesVideoFrameCallback: boolean;
  /** Monotonic frame sequence for latest-frame-wins blur commands. */
  frameSeq: number;
  /** Increment to terminate rVFC / interval loops for this element. */
  captureSession: number;
  /** Last requestVideoFrameCallback handle (for cancelVideoFrameCallback). */
  rvfcHandle: number | null;
  /** Reconcile capture target when decoded dimensions become available. */
  onMetadataLoaded: () => void;
  /** Backend request gate and streak tracking. */
  analysis: VideoAnalysisState;
  /** True after first-sample listeners were attached. */
  firstSampleScheduled: boolean;
  /** Handler shared across first-sample media events. */
  onFirstSampleReady: () => void;
  /** Timeout handle for stale in-flight analysis. */
  analysisTimeoutId: BrowserTimerId | null;
  /** Retry timer when the first sample has no frame data yet. */
  firstSampleRetryId: BrowserTimerId | null;
  /** Fires startup safety window when the primary player starts playing. */
  onPlayingForStartup: () => void;
  /** Handles seek/jump — invalidate streaks and rescan. */
  onSeekOrJump: () => void;
  /** Scheduled next-frame analysis timer. */
  nextScanTimerId: BrowserTimerId | null;
  /** Last currentTime used for playback-progress gate. */
  lastVideoTimeForProgressCheck: number;
  /** Last currentTime seen for scene-change detection. */
  lastSceneCheckTime: number;
  /** Scene-change listener. */
  onSceneChange: () => void;
}

const trackedVideos = new WeakMap<HTMLVideoElement, VideoTrackState>();
const videoIdToElement = new Map<number, HTMLVideoElement>();

let nextVideoId = 1;
let observer: MutationObserver | null = null;
let isMonitorRunning = false;
let settingsStorageListenerRegistered = false;
let runtimeMessageListenerRegistered = false;
let spaNavigationHooked = false;

/** Cached settings for synchronous gating in hot paths. */
let cachedContentSettings: SafeViewSettings | null = null;

/** Browser timer handle (DOM lib returns number; avoids NodeJS.Timeout mismatch). */
type BrowserTimerId = number;

/**
 * Diagnostic: count of in-flight canvas encodes (exported for tests).
 */
export function getActiveCaptureCount(): number {
  return activeCaptureCount;
}

/**
 * Diagnostic: global capture generation (exported for tests).
 */
export function getGlobalCaptureGeneration(): number {
  return globalCaptureGeneration;
}

/**
 * True when this video is the sole element running the capture loop.
 *
 * @param video - HTMLVideoElement to check.
 */
export function isPrimaryCaptureTarget(video: HTMLVideoElement): boolean {
  return primaryCaptureVideo === video;
}

/**
 * Sampling interval for the current playback / visibility state.
 *
 * @param video - Target HTMLVideoElement.
 * @returns Milliseconds between frame samples.
 */
export function getSampleIntervalMs(video: HTMLVideoElement): number {
  if (document.hidden) {
    return SAMPLE_INTERVAL_HIDDEN_MS;
  }

  if (video.paused) {
    return SAMPLE_INTERVAL_PAUSED_MS;
  }

  const state = trackedVideos.get(video);
  if (state?.analysis.safetyState) {
    return getIntervalForMode(state.analysis.safetyState);
  }

  return SAFE_MONITORING_INTERVAL_MS;
}

/**
 * Scan interval for the current safety mode.
 */
export function getIntervalForMode(mode: VideoSafetyState): number {
  switch (mode) {
    case "STARTUP_CHECKING":
      return STARTUP_SCAN_INTERVAL_MS;
    case "UNSAFE_BLURRED":
      return UNSAFE_MONITORING_INTERVAL_MS;
    case "SAFE_MONITORING":
      return SAFE_MONITORING_INTERVAL_MS;
    case "ENDED":
      return SAFE_MONITORING_INTERVAL_MS;
    default:
      return SAFE_MONITORING_INTERVAL_MS;
  }
}

/**
 * Create default per-video backend analysis state.
 */
function createAnalysisState(): VideoAnalysisState {
  return {
    safetyState: "SAFE_MONITORING",
    isAnalyzing: false,
    lastAnalysisStartedAt: 0,
    requestId: 0,
    sessionId: 0,
    firstDecisionMade: false,
    confirmedUnsafe: false,
    startupBlurActive: false,
    startupBlurExpiresAt: 0,
    startupWindowStarted: false,
    isBlurred: false,
    safeStreak: 0,
    unsafeStreak: 0,
    captureInProgress: false,
    encodeInProgress: false,
    pendingRequest: false,
    pendingRequestStartedAt: 0,
    pendingCapturedVideoTime: -1,
    lastCapturedVideoTime: -1,
    lastResponseAt: 0,
    lastBlurAppliedAt: 0,
    unsafeLockUntil: 0,
    scanLoopRunning: false,
    startupBlurTimer: null,
    fastEncodeMode: false,
    fastEncodeScansRemaining: 0,
    forceNextScan: false,
  };
}

/**
 * True when the video element has decoded frame dimensions ready to capture.
 */
function canCaptureFrame(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}

/**
 * True when the video is large enough and visibly on-screen (not a thumbnail/hidden ad).
 */
function isVideoVisibleInLayout(video: HTMLVideoElement): boolean {
  if (!video.isConnected) {
    return false;
  }

  const rect = video.getBoundingClientRect();
  if (rect.width < MIN_VISIBLE_LAYOUT_PX || rect.height < MIN_VISIBLE_LAYOUT_PX) {
    return false;
  }

  const style = window.getComputedStyle(video);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  if (parseFloat(style.opacity) <= 0) {
    return false;
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  if (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= viewportHeight ||
    rect.left >= viewportWidth
  ) {
    return false;
  }

  return true;
}

/**
 * True when this is the real primary playing video eligible for blur and analysis.
 */
export function isEligiblePrimaryPlayingVideo(video: HTMLVideoElement): boolean {
  if (!STARTUP_TEMP_BLUR_ENABLED && !isNudityProtectionActiveCached()) {
    return false;
  }

  if (
    video.hasAttribute("poster") &&
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return false;
  }

  return isPrimaryPlayingVideo(video);
}

/**
 * True when the element is the main visible player (not a thumbnail/ad preview).
 */
function isPrimaryVisiblePlayer(video: HTMLVideoElement): boolean {
  if (!video.isConnected || !isVideoVisibleInLayout(video)) {
    return false;
  }
  if (findPrimaryVisibleVideo() !== video) {
    return false;
  }
  if (video.closest("ytd-thumbnail, .ytd-thumbnail, [class*='thumbnail']")) {
    return false;
  }
  if (video.closest("[class*='ad-'], [class*='preview'], ytd-display-ad-renderer")) {
    return false;
  }
  if (video.tagName.toLowerCase() === "img") {
    return false;
  }
  return true;
}

/**
 * True when the main player is actively playing decoded frames.
 */
function isPrimaryPlayingVideo(video: HTMLVideoElement): boolean {
  if (!isNudityProtectionActiveCached()) {
    return false;
  }
  if (document.hidden) {
    return false;
  }
  if (!isPrimaryVisiblePlayer(video)) {
    return false;
  }
  if (video.paused || video.ended) {
    return false;
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return false;
  }
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    return false;
  }
  return true;
}

/**
 * Gate frame analysis — allows static/image-like frames while currentTime progresses.
 */
export function shouldAnalyzeFrame(
  video: HTMLVideoElement,
  state: VideoTrackState
): boolean {
  if (!isPrimaryPlayingVideo(video)) {
    return false;
  }

  if (state.analysis.safetyState === "STARTUP_CHECKING") {
    return true;
  }

  const prevProgressTime = state.lastVideoTimeForProgressCheck;
  const timeProgressing =
    prevProgressTime < 0 ||
    Math.abs(video.currentTime - prevProgressTime) > VIDEO_TIME_PROGRESS_MIN_SEC;

  state.lastVideoTimeForProgressCheck = video.currentTime;

  if (!timeProgressing && !state.analysis.forceNextScan) {
    console.debug("[SafeView][Gate] skipped non-progressing frame");
    return false;
  }

  const imageLikeStatic =
    state.lastSampledTime >= 0 &&
    Math.abs(video.currentTime - state.lastSampledTime) < 0.02;

  if (imageLikeStatic && timeProgressing) {
    console.info(
      "[SafeView][Gate] image-like frame inside playing video — analyzing for nudity"
    );
  } else if (timeProgressing && state.analysis.forceNextScan) {
    console.info(
      "[SafeView][Gate] main video frame is static-looking but time is progressing — analyze anyway"
    );
  }

  state.analysis.forceNextScan = false;
  return true;
}

/**
 * @deprecated Use shouldAnalyzeFrame — inverted skip check.
 */
function shouldSkipVideoForAnalysis(video: HTMLVideoElement): boolean {
  const state = trackedVideos.get(video);
  if (!state) {
    return true;
  }
  return !shouldAnalyzeFrame(video, state);
}

function clearStartupBlurTimer(state: VideoTrackState): void {
  if (state.analysis.startupBlurTimer !== null) {
    clearTimeout(state.analysis.startupBlurTimer);
    state.analysis.startupBlurTimer = null;
  }
}

function applyBlur(video: HTMLVideoElement, reason: string): void {
  applyImmediateLocalBlur(video);
  const state = trackedVideos.get(video);
  if (state) {
    state.analysis.isBlurred = true;
    state.analysis.lastBlurAppliedAt = Date.now();
  }
  console.info("[SafeView][Blur] apply %s", reason);
}

function clearBlur(video: HTMLVideoElement, reason: string): void {
  if (isFullVideoBlurred(video)) {
    clearImmediateLocalBlur(video);
  }
  const state = trackedVideos.get(video);
  if (state) {
    state.analysis.isBlurred = false;
  }
  console.info("[SafeView][Blur] clear %s", reason);
}

/**
 * Apply startup safety blur (max 1s); send first frame immediately.
 */
function startStartupSafetyWindow(video: HTMLVideoElement, state: VideoTrackState): void {
  if (!isEligiblePrimaryPlayingVideo(video)) {
    if (video.closest("ytd-thumbnail, .ytd-thumbnail, [class*='thumbnail']")) {
      console.info("[SafeView][Gate] skipped thumbnail/static/ad — no startup blur");
    } else {
      console.info("[SafeView][Gate] skipped non-primary/static video — no startup blur");
    }
    return;
  }

  if (state.analysis.startupWindowStarted && state.analysis.startupBlurActive) {
    return;
  }

  clearStartupBlurTimer(state);
  state.analysis.startupWindowStarted = true;
  state.analysis.safetyState = "STARTUP_CHECKING";
  applyBlur(video, "startup-safety-window");
  state.analysis.startupBlurActive = true;
  state.analysis.isBlurred = true;
  state.analysis.firstDecisionMade = false;
  state.analysis.confirmedUnsafe = false;
  state.analysis.safeStreak = 0;
  state.analysis.unsafeStreak = 0;
  state.analysis.startupBlurExpiresAt = Date.now() + STARTUP_TEMP_BLUR_MAX_MS;
  state.analysis.forceNextScan = true;

  console.info("[SafeView][Startup] temporary blur applied max=1000ms");

  scheduleImmediateScan(video, "startup-first-frame");

  state.analysis.startupBlurTimer = window.setTimeout(() => {
    state.analysis.startupBlurTimer = null;
    if (
      state.analysis.startupBlurActive &&
      !state.analysis.confirmedUnsafe
    ) {
      clearBlur(video, "startup-expired-no-unsafe");
      state.analysis.startupBlurActive = false;
      state.analysis.isBlurred = false;
      state.analysis.safetyState = "SAFE_MONITORING";
      console.info(
        "[SafeView][Startup] expired after 1000ms — unblur safe/unknown video"
      );
      console.info("[SafeView][State] STARTUP_CHECKING -> SAFE_MONITORING");
      console.info("[SafeView][Monitor] SAFE_MONITORING active");
      ensureScanLoopRunning(video, state, "startup-expired-safe-monitoring");
      scheduleNextScan(video, state, SAFE_MONITORING_INTERVAL_MS, "startup-expired");
    }
  }, STARTUP_TEMP_BLUR_MAX_MS);
}

function clearNextScanTimer(state: VideoTrackState): void {
  if (state.nextScanTimerId !== null) {
    clearTimeout(state.nextScanTimerId);
    state.nextScanTimerId = null;
  }
}

/**
 * True when continuous monitoring should pause for this element.
 */
function shouldPauseMonitoring(video: HTMLVideoElement, state: VideoTrackState): boolean {
  if (!video.isConnected || !document.contains(video) || video.ended) {
    return true;
  }
  if (!isNudityProtectionActiveCached()) {
    return true;
  }
  if (state.analysis.safetyState === "ENDED") {
    return true;
  }
  if (primaryCaptureVideo !== video) {
    return true;
  }
  if (video.paused) {
    return true;
  }
  return false;
}

/**
 * Schedule the next frame analysis (core continuous-monitoring driver).
 */
function scheduleNextScan(
  video: HTMLVideoElement,
  state: VideoTrackState,
  delayMs: number,
  reason: string
): void {
  if (!isMonitorRunning || state.analysis.safetyState === "ENDED") {
    return;
  }

  if (video.ended) {
    state.analysis.safetyState = "ENDED";
    return;
  }

  clearNextScanTimer(state);
  const mode = state.analysis.safetyState;

  state.nextScanTimerId = window.setTimeout(() => {
    state.nextScanTimerId = null;
    const current = trackedVideos.get(video);
    if (!current || current.captureSession !== state.captureSession) {
      return;
    }

    if (shouldPauseMonitoring(video, current)) {
      if (!video.ended && video.paused) {
        scheduleNextScan(video, current, SAMPLE_INTERVAL_PAUSED_MS, "paused-retry");
      }
      return;
    }

    ensureScanLoopRunning(video, current, reason);
    void sampleFrame(video, current.captureSession, true);
  }, delayMs);

  console.info(
    "[SafeView][Monitor] next scan scheduled mode=%s delay=%s reason=%s",
    mode,
    delayMs,
    reason
  );
}

/**
 * Release in-flight capture flags and queue the next scan.
 */
function finishAnalysis(
  video: HTMLVideoElement,
  state: VideoTrackState,
  reason: string
): void {
  state.analysis.captureInProgress = false;
  state.analysis.encodeInProgress = false;
  state.analysis.pendingRequest = false;
  clearAnalysisTimeout(state);

  if (shouldPauseMonitoring(video, state)) {
    if (!video.ended && video.paused) {
      scheduleNextScan(video, state, SAMPLE_INTERVAL_PAUSED_MS, reason);
    }
    return;
  }

  const delay = getIntervalForMode(state.analysis.safetyState);
  scheduleNextScan(video, state, delay, reason);
}

/**
 * Keep rVFC / interval loop alive for the primary player.
 */
function ensureScanLoopRunning(
  video: HTMLVideoElement,
  state: VideoTrackState,
  reason: string
): void {
  if (state.analysis.safetyState === "ENDED") {
    return;
  }
  if (!state.analysis.scanLoopRunning) {
    startScanLoop(video, state, reason);
    return;
  }
  if (!state.usesVideoFrameCallback && state.intervalId === null) {
    startScanLoop(video, state, reason);
  }
}

/**
 * Debounced immediate frame capture (one scan loop per video).
 */
export function scheduleImmediateScan(
  video: HTMLVideoElement,
  reason: string
): void {
  const state = trackedVideos.get(video);
  if (!state) {
    return;
  }

  const existing = immediateScanTimers.get(video);
  if (existing !== undefined) {
    clearTimeout(existing);
  }

  const immediateDelay =
    reason === "startup-first-frame" || reason === "playing"
      ? FIRST_FRAME_ANALYSIS_DELAY_MS
      : IMMEDIATE_SCAN_DEBOUNCE_MS;

  const runImmediate = (): void => {
    immediateScanTimers.delete(video);
    if (shouldSkipVideoForAnalysis(video)) {
      scheduleNextScan(video, state, FIRST_SAMPLE_RETRY_MS, "immediate-skip-retry");
      return;
    }
    if (canCaptureFrame(video)) {
      console.info("[SafeView][Realtime] first sample sent immediately");
      void sampleFrame(video, state.captureSession, true);
    } else if (!state.firstSampleScheduled) {
      scheduleFirstSample(video, state);
    } else {
      scheduleNextScan(video, state, FIRST_SAMPLE_RETRY_MS, "immediate-no-frame");
    }
  };

  if (immediateDelay <= 0) {
    runImmediate();
    return;
  }

  immediateScanTimers.set(
    video,
    window.setTimeout(runImmediate, immediateDelay)
  );
}

/**
 * Clear the backend timeout timer for one tracked video.
 */
function clearAnalysisTimeout(state: VideoTrackState): void {
  if (state.analysisTimeoutId !== null) {
    clearTimeout(state.analysisTimeoutId);
    state.analysisTimeoutId = null;
  }
}

/**
 * Mark backend analysis complete when the matching requestId finishes.
 */
function markAnalysisComplete(state: VideoTrackState, requestId: number): void {
  if (requestId > 0 && requestId < state.analysis.requestId) {
    return;
  }

  clearAnalysisTimeout(state);
  state.analysis.isAnalyzing = false;
  state.analysis.pendingRequest = false;
}

/**
 * Ignore backend commands when the sampled frame is too far from current playback.
 */
function isStalePlaybackResult(
  video: HTMLVideoElement,
  state: VideoTrackState,
  capturedVideoTime: number,
  responseAgeMs: number
): boolean {
  if (responseAgeMs > STALE_RESPONSE_MS) {
    return true;
  }
  if (capturedVideoTime < 0) {
    return false;
  }
  const drift = Math.abs(video.currentTime - capturedVideoTime);
  return drift > MAX_APPLY_TIME_DRIFT_SEC;
}

/**
 * Handle FRAME_ANALYSIS_DONE from the service worker (content-side state machine).
 */
function handleFrameAnalysisDone(
  videoId: number,
  requestId?: number,
  decision?: string,
  reason?: string,
  meta?: {
    detected?: boolean;
    confidence?: number;
    action?: string;
    capturedVideoTime?: number;
    responseAgeMs?: number;
  }
): void {
  const video = videoIdToElement.get(videoId);
  if (!video) {
    return;
  }

  const state = trackedVideos.get(video);
  if (!state) {
    return;
  }

  let finishReason = "analysis-done";

  try {
    const effectiveRequestId = requestId ?? state.analysis.requestId;
    if (requestId !== undefined && requestId > 0 && requestId < state.analysis.requestId) {
      console.debug("[SafeView][Pipeline] ignored stale request=%s", requestId);
      finishReason = "stale-request-id";
      return;
    }

    const capturedVideoTime =
      meta?.capturedVideoTime ?? state.analysis.pendingCapturedVideoTime;
    const responseAgeMs = meta?.responseAgeMs ?? 0;
    if (isStalePlaybackResult(video, state, capturedVideoTime, responseAgeMs)) {
      const drift =
        capturedVideoTime >= 0
          ? Math.abs(video.currentTime - capturedVideoTime)
          : 0;
    console.info(
      "[SafeView][Timing] ignored delayed result — monitoring continues drift=%s",
      drift.toFixed(3)
    );
    markAnalysisComplete(state, effectiveRequestId);
    finishReason = "stale-playback";
    state.analysis.forceNextScan = true;
    return;
    }

    markAnalysisComplete(state, effectiveRequestId);
    state.analysis.lastResponseAt = Date.now();

    const isFreshResponse =
      requestId === undefined || requestId <= 0 || requestId === state.analysis.requestId;
    const detected = meta?.detected === true;
    const action = meta?.action ?? "";
    const confidence = meta?.confidence ?? 0;
    const prevMode = state.analysis.safetyState;

    const isUnsafeResult =
      isFreshResponse &&
      (decision === "BLUR" ||
        (detected && action === "BLUR" && confidence >= NUDITY_BLUR_THRESHOLD));

    const isSafeResult =
      isFreshResponse &&
      (decision === "CLEAR" ||
        reason === "animation-skip" ||
        (!detected && action === "ALLOW") ||
        action === "ALLOW");

    if (isUnsafeResult) {
      state.analysis.firstDecisionMade = true;
      state.analysis.confirmedUnsafe = true;
      state.analysis.startupBlurActive = false;
      state.analysis.isBlurred = true;
      state.analysis.safeStreak = 0;
      state.analysis.unsafeStreak += 1;
      state.analysis.unsafeLockUntil = Date.now() + MIN_CONFIRMED_UNSAFE_HOLD_MS;
      clearStartupBlurTimer(state);

      if (prevMode === "SAFE_MONITORING") {
        state.analysis.safetyState = "UNSAFE_BLURRED";
        applyBlur(video, "middle-confirmed-unsafe");
        console.info("[SafeView][State] SAFE_MONITORING -> UNSAFE_BLURRED");
        console.info("[SafeView][Nudity] middle unsafe detected — blur applied");
      } else if (prevMode === "STARTUP_CHECKING") {
        state.analysis.safetyState = "UNSAFE_BLURRED";
        applyBlur(video, "confirmed-nudity");
        console.info("[SafeView][State] STARTUP_CHECKING -> UNSAFE_BLURRED");
        console.info("[SafeView][Nudity] confirmed unsafe — keep blur");
      } else {
        state.analysis.safetyState = "UNSAFE_BLURRED";
        applyBlur(video, "confirmed-nudity");
      }
      console.info("[SafeView][Pipeline] decision=BLUR reason=confirmed-nudity");
      finishReason = "unsafe-result";
      return;
    }

    if (isSafeResult) {
      if (reason === "animation-skip") {
        state.analysis.confirmedUnsafe = false;
        state.analysis.startupBlurActive = false;
        state.analysis.safetyState = "SAFE_MONITORING";
        state.analysis.isBlurred = false;
        state.analysis.safeStreak = 0;
        state.analysis.unsafeStreak = 0;
        clearStartupBlurTimer(state);
        clearBlur(video, "animation-skip");
        console.info("[SafeView][Gate] animation/cartoon skipped — monitoring continues");
        finishReason = "animation-skip";
        return;
      }

      state.analysis.safeStreak += 1;
      state.analysis.unsafeStreak = 0;

      if (prevMode === "STARTUP_CHECKING" && isFreshResponse) {
        clearBlur(video, "first-safe-result");
        state.analysis.startupBlurActive = false;
        state.analysis.isBlurred = false;
        state.analysis.firstDecisionMade = true;
        state.analysis.confirmedUnsafe = false;
        state.analysis.safetyState = "SAFE_MONITORING";
        clearStartupBlurTimer(state);
        console.info("[SafeView][Startup] first result safe — unblur immediately");
        console.info("[SafeView][State] STARTUP_CHECKING -> SAFE_MONITORING");
        console.info("[SafeView][Monitor] SAFE_MONITORING active");
        console.info("[SafeView][Monitor] continuing scan after first safe");
        ensureScanLoopRunning(video, state, "safe-monitoring-after-first-safe");
        finishReason = "first-safe-result";
        return;
      }

      if (
        prevMode === "UNSAFE_BLURRED" &&
        state.analysis.confirmedUnsafe &&
        state.analysis.safeStreak >= SAFE_CONFIRMATIONS_TO_CLEAR &&
        Date.now() > state.analysis.unsafeLockUntil
      ) {
        clearBlur(video, "safe-again-after-unsafe");
        state.analysis.confirmedUnsafe = false;
        state.analysis.isBlurred = false;
        state.analysis.safetyState = "SAFE_MONITORING";
        console.info("[SafeView][State] UNSAFE_BLURRED -> SAFE_MONITORING");
        console.info("[SafeView][Monitor] SAFE_MONITORING active");
        console.info(
          "[SafeView][Blur] cleared after 2 safe confirmations, monitoring continues"
        );
        finishReason = "safe-again-after-unsafe";
        return;
      }

      if (!state.analysis.confirmedUnsafe && isFreshResponse) {
        state.analysis.firstDecisionMade = true;
        state.analysis.safetyState = "SAFE_MONITORING";
        if (state.analysis.isBlurred) {
          clearBlur(video, "safe-frame");
          state.analysis.isBlurred = false;
        }
        console.info("[SafeView][Pipeline] decision=ALLOW reason=safe-frame");
      }
      finishReason = "safe-frame";
      return;
    }

    if (decision === "HOLD") {
      if (reason === "backend_untrusted" || reason === "backend_error") {
        if (state.analysis.startupBlurActive) {
          console.info(
            "[SafeView][Timeout] backend timeout — startup blur will expire, not unsafe"
          );
        } else {
          console.info("[SafeView][Timeout] backend timeout — not unsafe");
        }
      }
      if (state.analysis.confirmedUnsafe && state.analysis.isBlurred) {
        applyBlur(video, "hold-confirmed-unsafe");
      }
      finishReason = `hold-${reason ?? "pending"}`;
      return;
    }

    if (state.analysis.confirmedUnsafe && state.analysis.isBlurred) {
      applyBlur(video, "hold-confirmed-unsafe");
    }
    finishReason = "analysis-hold";
  } finally {
    finishAnalysis(video, state, finishReason);
  }
}

/**
 * Attach first-sample listeners and fire the first capture as soon as frame data exists.
 */
function scheduleFirstSample(video: HTMLVideoElement, state: VideoTrackState): void {
  if (state.firstSampleScheduled) {
    return;
  }

  state.firstSampleScheduled = true;

  const tryFirstSample = (): void => {
    if (findPrimaryVisibleVideo() !== video) {
      return;
    }

    if (!canCaptureFrame(video)) {
      if (state.firstSampleRetryId === null) {
        state.firstSampleRetryId = window.setTimeout(() => {
          state.firstSampleRetryId = null;
          tryFirstSample();
        }, FIRST_SAMPLE_RETRY_MS);
      }
      return;
    }

    void sampleFrame(video, state.captureSession, true);
  };

  const eventNames = [
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "playing",
    "timeupdate",
  ] as const;

  for (const eventName of eventNames) {
    video.addEventListener(eventName, state.onFirstSampleReady, { passive: true });
  }

  if (FIRST_FRAME_ANALYSIS_DELAY_MS === 0) {
    tryFirstSample();
  } else {
    window.setTimeout(tryFirstSample, FIRST_FRAME_ANALYSIS_DELAY_MS);
  }
}

/**
 * Detach first-sample listeners and timers for one video.
 */
function teardownFirstSampleListeners(
  video: HTMLVideoElement,
  state: VideoTrackState
): void {
  const eventNames = [
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "playing",
    "timeupdate",
  ] as const;

  for (const eventName of eventNames) {
    video.removeEventListener(eventName, state.onFirstSampleReady);
  }

  if (state.firstSampleRetryId !== null) {
    clearTimeout(state.firstSampleRetryId);
    state.firstSampleRetryId = null;
  }

  clearAnalysisTimeout(state);
}

/**
 * True when the browser supports requestVideoFrameCallback on video elements.
 */
function supportsVideoFrameCallback(video: HTMLVideoElement): boolean {
  return typeof video.requestVideoFrameCallback === "function";
}

/**
 * True when cancelVideoFrameCallback is available.
 */
function supportsCancelVideoFrameCallback(video: HTMLVideoElement): boolean {
  return typeof video.cancelVideoFrameCallback === "function";
}

/**
 * Register a video for FRAME_SAMPLE and subtitle paths (native DOM only).
 *
 * @param video - HTMLVideoElement discovered on the page.
 */
export function initAudioCaptureForElement(video: HTMLVideoElement): void {
  if (!isNudityProtectionActiveCached()) {
    return;
  }

  ensureVideoRegistered(video);
}

/**
 * True when protection and nudity are enabled (uses cached content settings).
 */
function isNudityProtectionActiveCached(): boolean {
  if (!cachedContentSettings) {
    return true;
  }

  return isNudityProtectionActive(cachedContentSettings);
}

/**
 * Reset per-video analysis counters after settings change or nudity off.
 */
function resetVideoAnalysisState(state: VideoTrackState): void {
  clearStartupBlurTimer(state);
  state.analysis = createAnalysisState();
  state.analysis.sessionId = state.captureSession;
  clearAnalysisTimeout(state);
}

/**
 * Reset analysis state on every tracked video.
 */
function resetAllAnalysisStates(): void {
  for (const video of videoIdToElement.values()) {
    const state = trackedVideos.get(video);
    if (state) {
      resetVideoAnalysisState(state);
    }
  }
}

/**
 * Stop capture loops for all tracked videos without unregistering them.
 */
export function stopAllSampling(): void {
  for (const video of [...videoIdToElement.values()]) {
    const state = trackedVideos.get(video);
    if (state) {
      stopSampling(video, state, "settings-off");
    }
  }

  primaryCaptureVideo = null;
}

/**
 * Fire an immediate first frame sample when frame data is ready.
 */
export function triggerImmediateFirstSample(video: HTMLVideoElement): void {
  const state = trackedVideos.get(video);
  if (!state) {
    return;
  }

  if (canCaptureFrame(video)) {
    void sampleFrame(video, state.captureSession, true);
    return;
  }

  if (!state.firstSampleScheduled) {
    scheduleFirstSample(video, state);
  }
}

/**
 * Register a video or re-activate an already-registered video after settings change.
 */
function ensureVideoRegistered(video: HTMLVideoElement): void {
  if (video.dataset[SAFE_VIEW_TRACKED_DATASET] === "true") {
    const state = trackedVideos.get(video);
    if (!state) {
      return;
    }

    resetVideoAnalysisState(state);
    reconcilePrimaryCaptureLoop("settings-rescan");
    return;
  }

  registerVideo(video);
}

/**
 * Scan the document for untracked <video> elements.
 */
function monitorVideos(): void {
  document.querySelectorAll("video").forEach((video) => {
    if (video.dataset[SAFE_VIEW_TRACKED_DATASET] !== "true") {
      initAudioCaptureForElement(video);
    }
  });
}

/**
 * Scan a DOM subtree for <video> elements and register any new ones.
 *
 * @param root - Node to scan (element or document fragment).
 */
function scanForVideos(root: Element | Document | DocumentFragment): void {
  if (root instanceof HTMLVideoElement) {
    initAudioCaptureForElement(root);
    return;
  }

  if ("querySelectorAll" in root) {
    root.querySelectorAll("video").forEach((video) => {
      initAudioCaptureForElement(video);
    });
  }
}

/**
 * Stop interval / rVFC capture for one video and invalidate its session.
 *
 * @param video - Target HTMLVideoElement.
 * @param state - Tracking state for the video.
 * @param reason - Diagnostic label for logs.
 */
function stopSampling(
  video: HTMLVideoElement,
  state: VideoTrackState,
  reason: string
): void {
  const endedSession = state.captureSession;
  state.captureSession += 1;

  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
    console.info(
      "[SafeView][Capture] INTERVAL CLEAR video=%s session=%s reason=%s",
      state.videoId,
      endedSession,
      reason
    );
  }

  if (
    state.rvfcHandle !== null &&
    supportsCancelVideoFrameCallback(video)
  ) {
    video.cancelVideoFrameCallback(state.rvfcHandle);
    console.info(
      "[SafeView][Capture] RVFC CANCEL video=%s session=%s handle=%s reason=%s",
      state.videoId,
      endedSession,
      state.rvfcHandle,
      reason
    );
    state.rvfcHandle = null;
  }

  state.usesVideoFrameCallback = false;
  state.analysis.safetyState = "ENDED";
  state.analysis.scanLoopRunning = false;
  state.analysis.captureInProgress = false;
  state.analysis.encodeInProgress = false;
  state.analysis.pendingRequest = false;
  state.analysis.startupWindowStarted = false;
  clearStartupBlurTimer(state);
  clearNextScanTimer(state);

  if (primaryCaptureVideo === video) {
    primaryCaptureVideo = null;
  }
}

/**
 * Drop tracking for videos no longer in the document (YouTube player swap).
 */
function pruneStaleTrackedVideos(): void {
  for (const video of [...videoIdToElement.values()]) {
    if (!video.isConnected) {
      unregisterVideo(video, "prune-disconnected");
    }
  }
}

/**
 * Invalidate every capture loop and re-bind only the current primary player.
 * Called from pipeline navigation when YouTube replaces the watch context.
 *
 * @param reason - Diagnostic label (navigation, yt-navigate-finish, etc.).
 */
export function resetVideoCaptureForNavigation(reason: string): void {
  globalCaptureGeneration += 1;

  for (const video of [...videoIdToElement.values()]) {
    const state = trackedVideos.get(video);
    if (state) {
      stopSampling(video, state, reason);
    }
  }

  primaryCaptureVideo = null;

  console.info(
    "[SafeView][Capture] RESET ALL reason=%s globalGen=%s tracked=%s activeCaptures=%s",
    reason,
    globalCaptureGeneration,
    videoIdToElement.size,
    activeCaptureCount
  );

  reconcilePrimaryCaptureLoop("after-reset");
}

/**
 * Stop capture on all videos; start exactly one loop on the largest visible player.
 *
 * @param reason - Diagnostic label.
 */
function reconcilePrimaryCaptureLoop(reason: string): void {
  const primary = findPrimaryVisibleVideo();

  for (const video of [...videoIdToElement.values()]) {
    const state = trackedVideos.get(video);
    if (!state) {
      continue;
    }

    if (video !== primary) {
      stopSampling(video, state, `not-primary:${reason}`);
    }
  }

  if (!primary) {
    primaryCaptureVideo = null;
    return;
  }

  primaryCaptureVideo = primary;

  const primaryState = trackedVideos.get(primary);
  if (!primaryState) {
    primaryCaptureVideo = null;
    return;
  }

  if (primary.paused === false && !primary.ended) {
    if (
      primaryState.analysis.safetyState !== "UNSAFE_BLURRED" &&
      !primaryState.analysis.startupWindowStarted
    ) {
      startStartupSafetyWindow(primary, primaryState);
    }
    scheduleImmediateScan(
      primary,
      reason === "register" ? "startup-first-frame" : reason
    );
  } else {
    scheduleFirstSample(primary, primaryState);
  }

  if (!primaryState.analysis.scanLoopRunning) {
    startScanLoop(primary, primaryState, reason);
  }
}

/**
 * Register a video element for gated frame sampling.
 *
 * @param video - HTMLVideoElement to track.
 */
function registerVideo(video: HTMLVideoElement): void {
  if (trackedVideos.has(video)) {
    return;
  }

  video.dataset[SAFE_VIEW_TRACKED_DATASET] = "true";
  prepareVideoCrossOrigin(video);

  const videoId = nextVideoId++;
  const onFirstSampleReady = (): void => {
    const current = trackedVideos.get(video);
    if (!current || findPrimaryVisibleVideo() !== video) {
      return;
    }

    if (canCaptureFrame(video)) {
      void sampleFrame(video, current.captureSession, true);
    }
  };

  const onPlayingForStartup = (): void => {
    const current = trackedVideos.get(video);
    if (!current || findPrimaryVisibleVideo() !== video) {
      return;
    }
    startStartupSafetyWindow(video, current);
    scheduleImmediateScan(video, "playing");
  };

  const onSeekOrJump = (): void => {
    const current = trackedVideos.get(video);
    if (!current || findPrimaryVisibleVideo() !== video) {
      return;
    }
    current.analysis.safeStreak = 0;
    current.analysis.unsafeStreak = 0;
    current.analysis.requestId += 1;
    current.analysis.pendingRequest = false;
    current.analysis.captureInProgress = false;
    current.analysis.encodeInProgress = false;
    current.analysis.forceNextScan = true;
    clearAnalysisTimeout(current);
    scheduleImmediateScan(video, "seek-or-jump");
  };

  const onSceneChange = (): void => {
    const current = trackedVideos.get(video);
    if (!current || findPrimaryVisibleVideo() !== video) {
      return;
    }
    const t = video.currentTime;
    if (
      current.lastSceneCheckTime >= 0 &&
      Math.abs(t - current.lastSceneCheckTime) >= SCENE_CHANGE_TIME_JUMP_SEC
    ) {
      current.analysis.forceNextScan = true;
      console.info("[SafeView][Scene] scene change detected — immediate analysis scheduled");
      scheduleImmediateScan(video, "scene-change");
    }
    current.lastSceneCheckTime = t;
  };

  const state: VideoTrackState = {
    videoId,
    lastSampleAt: 0,
    intervalId: null,
    isCapturing: false,
    lastSampledTime: -1,
    usesVideoFrameCallback: false,
    frameSeq: 0,
    captureSession: 0,
    rvfcHandle: null,
    onMetadataLoaded: () => {
      reconcilePrimaryCaptureLoop("loadedmetadata");
    },
    analysis: createAnalysisState(),
    firstSampleScheduled: false,
    onFirstSampleReady,
    onPlayingForStartup,
    onSeekOrJump,
    onSceneChange,
    analysisTimeoutId: null,
    firstSampleRetryId: null,
    nextScanTimerId: null,
    lastVideoTimeForProgressCheck: -1,
    lastSceneCheckTime: -1,
  };

  trackedVideos.set(video, state);
  videoIdToElement.set(videoId, video);
  video.addEventListener("loadedmetadata", state.onMetadataLoaded);
  video.addEventListener("playing", state.onPlayingForStartup, { passive: true });
  video.addEventListener("seeking", state.onSeekOrJump, { passive: true });
  video.addEventListener("seeked", state.onSeekOrJump, { passive: true });
  video.addEventListener("timeupdate", state.onSceneChange, { passive: true });
  onYouTubeWatchIdBoundary("new-video-registered");
  startSubtitleMonitor(video);
  onVideoTrackedForSpeakerSuppression(video);

  console.info(
    "[SafeView][Capture] REGISTER video=%s session=0 tracked=%s",
    videoId,
    videoIdToElement.size
  );

  reconcilePrimaryCaptureLoop("register");
}

/**
 * Stop sampling and release tracking for a removed video element.
 *
 * @param video - HTMLVideoElement that left the DOM.
 * @param reason - Diagnostic label.
 */
function unregisterVideo(video: HTMLVideoElement, reason = "unregister"): void {
  const state = trackedVideos.get(video);
  if (!state) {
    return;
  }

  stopSampling(video, state, reason);
  clearStartupBlurTimer(state);
  video.removeEventListener("loadedmetadata", state.onMetadataLoaded);
  video.removeEventListener("playing", state.onPlayingForStartup);
  video.removeEventListener("seeking", state.onSeekOrJump);
  video.removeEventListener("seeked", state.onSeekOrJump);
  video.removeEventListener("timeupdate", state.onSceneChange);
  clearNextScanTimer(state);
  teardownFirstSampleListeners(video, state);
  const debounced = immediateScanTimers.get(video);
  if (debounced !== undefined) {
    clearTimeout(debounced);
    immediateScanTimers.delete(video);
  }
  stopSubtitleMonitor(video);
  videoIdToElement.delete(state.videoId);
  trackedVideos.delete(video);
  delete video.dataset[SAFE_VIEW_TRACKED_DATASET];

  console.info(
    "[SafeView][Capture] UNREGISTER video=%s reason=%s tracked=%s",
    state.videoId,
    reason,
    videoIdToElement.size
  );

  reconcilePrimaryCaptureLoop("unregister");
}

/**
 * Schedule frame sampling via requestVideoFrameCallback (primary player only).
 *
 * @param video - Target video element.
 * @param state - Tracking state.
 * @param session - Capture session id at loop start.
 */
function startVideoFrameCallbackSampling(
  video: HTMLVideoElement,
  state: VideoTrackState,
  session: number
): void {
  const tick = (
    _now: number,
    _metadata: VideoFrameCallbackMetadata
  ): void => {
    const current = trackedVideos.get(video);

    if (!current || current.captureSession !== session) {
      console.info(
        "[SafeView][Capture] RVFC STOP video=%s stale session=%s current=%s",
        state.videoId,
        session,
        current?.captureSession ?? "gone"
      );
      return;
    }

    console.debug(
      "[SafeView][Capture] RVFC FIRE video=%s session=%s activeCaptures=%s",
      state.videoId,
      session,
      activeCaptureCount
    );

    const runImmediate =
      current.analysis.safetyState === "STARTUP_CHECKING" ||
      current.analysis.pendingRequest ||
      current.analysis.captureInProgress;
    void sampleFrame(video, session, runImmediate);

    const after = trackedVideos.get(video);
    if (!after || after.captureSession !== session) {
      return;
    }

    after.rvfcHandle = video.requestVideoFrameCallback(tick);
    console.debug(
      "[SafeView][Capture] RVFC REGISTER video=%s session=%s handle=%s",
      state.videoId,
      session,
      after.rvfcHandle
    );
  };

  state.usesVideoFrameCallback = true;
  state.rvfcHandle = video.requestVideoFrameCallback(tick);
  console.info(
    "[SafeView][Capture] RVFC START video=%s session=%s handle=%s",
    state.videoId,
    session,
    state.rvfcHandle
  );
}

/**
 * Begin gated sampling for one video (rVFC when available, else setInterval).
 *
 * @param video - Target video element (must be primary visible player).
 * @param state - WeakMap entry for the video.
 * @param reason - Diagnostic label.
 */
function startScanLoop(video: HTMLVideoElement, state: VideoTrackState, reason: string): void {
  if (state.analysis.scanLoopRunning) {
    console.debug("[SafeView][Capture] scan loop already running");
    return;
  }

  state.analysis.scanLoopRunning = true;
  console.info("[SafeView][Capture] scan loop started reason=%s", reason);
  startSampling(video, state, reason);
}

function startSampling(
  video: HTMLVideoElement,
  state: VideoTrackState,
  reason: string
): void {
  if (state.intervalId !== null || state.usesVideoFrameCallback) {
    return;
  }

  const session = state.captureSession;
  state.analysis.sessionId = session;

  console.info(
    "[SafeView][Capture] START video=%s session=%s reason=%s mode=%s",
    state.videoId,
    session,
    reason,
    supportsVideoFrameCallback(video) ? "rvfc" : "interval"
  );

  if (supportsVideoFrameCallback(video)) {
    startVideoFrameCallbackSampling(video, state, session);
    return;
  }

  const tick = (): void => {
    const current = trackedVideos.get(video);
    if (!current || current.captureSession !== session) {
      return;
    }
    void sampleFrame(video, session, true);
  };

  const intervalMs = getIntervalForMode(state.analysis.safetyState);
  state.intervalId = window.setInterval(tick, intervalMs);

  console.info(
    "[SafeView][Capture] INTERVAL START video=%s session=%s ms=%s mode=%s",
    state.videoId,
    session,
    intervalMs,
    state.analysis.safetyState
  );
}

/**
 * Compute downscaled capture dimensions (max width CAPTURE_MAX_WIDTH_PX).
 *
 * @param videoWidth - Native video width in pixels.
 * @param videoHeight - Native video height in pixels.
 * @returns Width and height for the offscreen canvas.
 */
function captureDimensions(
  videoWidth: number,
  videoHeight: number,
  maxWidth: number = CAPTURE_MAX_WIDTH_PX
): { width: number; height: number } {
  if (videoWidth <= maxWidth) {
    return { width: videoWidth, height: videoHeight };
  }

  const scale = maxWidth / videoWidth;
  return {
    width: maxWidth,
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

/**
 * Returns true when the drawn frame is likely blank or near-black.
 */
function isFrameLikelyBlank(
  context: CanvasRenderingContext2D,
  width: number,
  height: number
): boolean {
  const sampleWidth = Math.min(32, width);
  const sampleHeight = Math.min(32, height);
  const sample = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let sum = 0;

  for (let i = 0; i < sample.length; i += 4) {
    sum += sample[i]! + sample[i + 1]! + sample[i + 2]!;
  }

  const pixelCount = sample.length / 4;
  const averageLuminance = sum / pixelCount / 3;
  return averageLuminance < MIN_FRAME_LUMINANCE;
}

/**
 * Draw the current video frame to an offscreen canvas and encode as JPEG.
 *
 * BR-02: canvas dimensions reset to 0 after toBlob — before messaging.
 */
async function captureVideoFrameToBlob(
  video: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
  quality: number
): Promise<{
  blob: Blob;
  captureMs: number;
  encodeMs: number;
} | null> {
  const captureStarted = performance.now();

  if (activeCaptureCount > 0) {
    console.debug("[SafeView][Capture] skip duplicate — previous encode in flight");
    return null;
  }

  activeCaptureCount += 1;

  try {
    const encodeStartedRef = { at: 0 };
    const allowBlankWhilePlaying = !video.paused && !video.ended;

    if (typeof OffscreenCanvas !== "undefined") {
      const offscreen = new OffscreenCanvas(canvasWidth, canvasHeight);
      const context = offscreen.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return null;
      }
      context.drawImage(video, 0, 0, canvasWidth, canvasHeight);
      if (
        !allowBlankWhilePlaying &&
        isFrameLikelyBlank(context as unknown as CanvasRenderingContext2D, canvasWidth, canvasHeight)
      ) {
        return null;
      }
      const captureMs = Math.round(performance.now() - captureStarted);
      encodeStartedRef.at = performance.now();
      const blob = await offscreen.convertToBlob({
        type: FRAME_MIME_TYPE,
        quality,
      });
      const encodeMs = Math.round(performance.now() - encodeStartedRef.at);
      if (!blob) {
        return null;
      }
      if (encodeMs > ENCODE_STALL_WARN_MS) {
        console.info(
          "[SafeView][Performance] encode slow — fast mode enabled width=128 quality=0.32 encodeMs=%s",
          encodeMs
        );
      }
      return { blob, captureMs, encodeMs };
    }

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, canvasWidth, canvasHeight);

    if (!allowBlankWhilePlaying && isFrameLikelyBlank(context, canvas.width, canvas.height)) {
      return null;
    }

    const captureMs = Math.round(performance.now() - captureStarted);
    encodeStartedRef.at = performance.now();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, FRAME_MIME_TYPE, quality);
    });

    const encodeMs = Math.round(performance.now() - encodeStartedRef.at);

    if (!blob) {
      return null;
    }

    if (encodeMs > ENCODE_STALL_WARN_MS) {
      console.info(
        "[SafeView][Performance] encode slow — fast mode enabled width=128 quality=0.32 encodeMs=%s",
        encodeMs
      );
    }

    purgeCanvas(canvas);
    return { blob, captureMs, encodeMs };
  } catch {
    console.warn(
      "[SafeView] Frame capture skipped (tainted canvas / CORS). Detection disabled for this source."
    );
    return null;
  } finally {
    activeCaptureCount = Math.max(0, activeCaptureCount - 1);
  }
}

/**
 * Release offscreen canvas memory per BR-02.
 */
function purgeCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Capture one JPEG frame and send it to the service worker when the gate allows.
 *
 * @param video - HTMLVideoElement to sample.
 * @param captureSession - Session id from the active capture loop.
 */
async function sampleFrame(
  video: HTMLVideoElement,
  captureSession: number,
  immediate = false
): Promise<void> {
  const state = trackedVideos.get(video);
  if (!state || state.captureSession !== captureSession) {
    return;
  }

  if (state.analysis.safetyState === "ENDED" || video.ended) {
    return;
  }

  if (primaryCaptureVideo !== video) {
    scheduleNextScan(video, state, 200, "not-primary-retry");
    return;
  }

  if (!shouldAnalyzeFrame(video, state)) {
    scheduleNextScan(video, state, SAFE_MONITORING_INTERVAL_MS, "ineligible-skip");
    return;
  }

  const now = performance.now();

  if (
    state.analysis.captureInProgress ||
    state.analysis.encodeInProgress ||
    state.analysis.pendingRequest
  ) {
    const pendingMs = now - state.analysis.pendingRequestStartedAt;
    if (pendingMs < MAX_PENDING_ANALYSIS_MS) {
      console.debug("[SafeView][Capture] skip duplicate — previous work pending");
      scheduleNextScan(video, state, 120, "pending-work");
      return;
    }

    console.warn("[SafeView][Timeout] pending request expired — allow fresh scan");
    if (state.analysis.startupBlurActive) {
      console.info(
        "[SafeView][Timeout] backend timeout — startup blur will expire, not unsafe"
      );
    } else {
      console.info(
        "[SafeView][Timeout] backend timeout — not unsafe video=%s pendingMs=%s",
        state.videoId,
        Math.round(pendingMs)
      );
    }
    state.analysis.pendingRequest = false;
    state.analysis.isAnalyzing = false;
    state.analysis.captureInProgress = false;
    state.analysis.encodeInProgress = false;
    clearAnalysisTimeout(state);
    finishAnalysis(video, state, "pending-timeout");
    return;
  }

  const intervalMs = getIntervalForMode(state.analysis.safetyState);
  if (!immediate && now - state.lastSampleAt < intervalMs) {
    scheduleNextScan(
      video,
      state,
      Math.max(50, intervalMs - (now - state.lastSampleAt)),
      "interval-wait"
    );
    return;
  }

  if (video.seeking) {
    scheduleNextScan(video, state, 80, "seeking-wait");
    return;
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    scheduleNextScan(video, state, FIRST_SAMPLE_RETRY_MS, "no-frame-data");
    return;
  }

  if (video.videoWidth === 0 || video.videoHeight === 0) {
    scheduleNextScan(video, state, FIRST_SAMPLE_RETRY_MS, "no-dimensions");
    return;
  }

  state.analysis.captureInProgress = true;

  const maxWidth = state.analysis.fastEncodeMode
    ? FAST_MODE_FRAME_WIDTH
    : CAPTURE_MAX_WIDTH_PX;
  const { width: canvasWidth, height: canvasHeight } = captureDimensions(
    video.videoWidth,
    video.videoHeight,
    maxWidth
  );
  const encodeQuality = state.analysis.fastEncodeMode
    ? FAST_MODE_QUALITY
    : JPEG_QUALITY;
  const seq = state.frameSeq + 1;
  const requestId = state.analysis.requestId + 1;
  const capturedVideoTime = video.currentTime;

  console.info(
    "[SafeView][Pipeline] frame captured video=%s session=%s request=%s time=%s",
    state.videoId,
    captureSession,
    requestId,
    capturedVideoTime.toFixed(3)
  );

  try {
    state.analysis.encodeInProgress = true;
    const result = await captureVideoFrameToBlob(
      video,
      canvasWidth,
      canvasHeight,
      encodeQuality
    );
    state.analysis.encodeInProgress = false;

    if (!result) {
      state.analysis.forceNextScan = true;
      finishAnalysis(video, state, "capture-skipped-retry");
      return;
    }

    const after = trackedVideos.get(video);
    if (!after || after.captureSession !== captureSession) {
      console.info(
        "[SafeView][Capture] ABORT stale video=%s session=%s after encode",
        state.videoId,
        captureSession
      );
      return;
    }

    if (result.encodeMs > ENCODE_STALL_WARN_MS) {
      after.analysis.fastEncodeMode = true;
      after.analysis.fastEncodeScansRemaining = FAST_MODE_DURATION_SCANS;
    } else if (after.analysis.fastEncodeScansRemaining > 0) {
      after.analysis.fastEncodeScansRemaining -= 1;
      if (after.analysis.fastEncodeScansRemaining === 0) {
        after.analysis.fastEncodeMode = false;
      }
    }

    const capturedAt = Date.now();
    after.frameSeq = seq;
    after.analysis.pendingCapturedVideoTime = capturedVideoTime;
    after.analysis.lastCapturedVideoTime = capturedVideoTime;

    console.info(
      "[SafeView][Latency] capture video=%s session=%s seq=%s captureMs=%s encodeMs=%s size=%s canvas=%sx%s native=%sx%s intervalMs=%s",
      after.videoId,
      captureSession,
      seq,
      result.captureMs,
      result.encodeMs,
      result.blob.size,
      canvasWidth,
      canvasHeight,
      video.videoWidth,
      video.videoHeight,
      intervalMs
    );

    after.lastSampleAt = now;
    after.lastSampledTime = video.currentTime;

    after.analysis.requestId = requestId;
    after.analysis.isAnalyzing = true;
    after.analysis.pendingRequest = true;
    after.analysis.pendingRequestStartedAt = now;
    after.analysis.lastAnalysisStartedAt = now;
    clearAnalysisTimeout(after);
    after.analysisTimeoutId = window.setTimeout(() => {
      const current = trackedVideos.get(video);
      if (
        !current ||
        current.captureSession !== captureSession ||
        current.analysis.requestId !== requestId
      ) {
        return;
      }
      if (current.analysis.isAnalyzing || current.analysis.pendingRequest) {
        current.analysis.isAnalyzing = false;
        current.analysis.pendingRequest = false;
        if (current.analysis.startupBlurActive) {
          console.info(
            "[SafeView][Timeout] backend timeout — startup blur will expire, not unsafe"
          );
        } else {
          console.info(
            "[SafeView][Timeout] backend timeout — not unsafe video=%s request=%s",
            current.videoId,
            requestId
          );
        }
        finishAnalysis(video, current, "backend-timeout");
      }
    }, BACKEND_TIMEOUT_MS);

    await sendFrameToServiceWorker(
      after.videoId,
      result.blob,
      capturedAt,
      capturedVideoTime,
      after.frameSeq,
      result.captureMs,
      result.encodeMs,
      captureSession,
      seq,
      requestId
    );
  } catch (error) {
    console.error("[SafeView] Frame sampling failed:", error);
    const current = trackedVideos.get(video);
    if (current && current.captureSession === captureSession) {
      finishAnalysis(video, current, "capture-error");
    }
  } finally {
    const current = trackedVideos.get(video);
    if (current && current.captureSession === captureSession) {
      if (!current.analysis.pendingRequest) {
        current.analysis.captureInProgress = false;
        current.analysis.encodeInProgress = false;
      }
    }

    console.debug(
      "[SafeView][Capture] END video=%s session=%s seq=%s",
      state.videoId,
      captureSession,
      seq
    );
  }
}

/**
 * Read JPEG bytes from a Blob.
 */
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("FileReader did not return ArrayBuffer"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("FileReader failed"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Send a frame to the MV3 service worker for backend analysis (ArrayBuffer transfer).
 */
async function sendFrameToServiceWorker(
  videoId: number,
  frame: Blob,
  capturedAt: number,
  capturedVideoTime: number,
  frameSeq: number,
  captureMs: number,
  encodeMs: number,
  captureSession: number,
  captureSeq: number,
  requestId: number
): Promise<void> {
  try {
    const transferStarted = performance.now();
    const frameBuffer = await blobToArrayBuffer(frame);
    /** Uint8Array survives structured clone more reliably than raw ArrayBuffer across realms. */
    const frameBytes = new Uint8Array(frameBuffer);
    const framePayload = Array.from(frameBytes);
    const transferMs = Math.round(performance.now() - transferStarted);
    const sentAt = Date.now();

    console.info(
      "[SafeView][Latency] transport video=%s session=%s seq=%s transferMs=%s bytes=%s frameSeq=%s tag=%s",
      videoId,
      captureSession,
      captureSeq,
      transferMs,
      frameBytes.byteLength,
      frameSeq,
      Object.prototype.toString.call(frameBytes)
    );

    void chrome.runtime
      .sendMessage({
        action: MESSAGE_ACTION_FRAME_SAMPLE,
        videoId,
        framePayload,
        frameBuffer: frameBytes,
        frameMimeType: frame.type || FRAME_MIME_TYPE,
        captureSession,
        contentBuild: chrome.runtime.getManifest().version,
        capturedAt,
        sentAt,
        frameSeq,
        requestId,
        captureMs,
        encodeMs,
        capturedVideoTime,
      })
      .catch(() => {
        /* Fire-and-forget; service worker acks immediately. */
      });
  } catch (error) {
    console.warn("[SafeView] Could not reach service worker:", error);
  }
}

/**
 * Handle MutationObserver records for added and removed nodes.
 */
function handleMutations(mutations: MutationRecord[]): void {
  let shouldReconcile = false;

  for (const mutation of mutations) {
    mutation.addedNodes.forEach((node) => {
      if (node instanceof HTMLVideoElement) {
        registerVideo(node);
      } else if (node instanceof Element) {
        scanForVideos(node);
      }
    });

    mutation.removedNodes.forEach((node) => {
      if (node instanceof HTMLVideoElement) {
        unregisterVideo(node, "mutation-removed");
        shouldReconcile = true;
      } else if (node instanceof Element) {
        node.querySelectorAll("video").forEach((video) => {
          unregisterVideo(video, "mutation-removed-child");
          shouldReconcile = true;
        });
      }
    });
  }

  if (shouldReconcile) {
    pruneStaleTrackedVideos();
    reconcilePrimaryCaptureLoop("mutation");
  }
}

/**
 * Re-scan the document after YouTube SPA navigation completes.
 */
function handleYouTubeNavigation(): void {
  console.info("[SafeView] YouTube navigation finished — rescanning for videos.");
  onYouTubeWatchIdBoundary("yt-navigate-finish");
  pruneStaleTrackedVideos();
  resetVideoCaptureForNavigation("yt-navigate-finish");
  void handleSettingsUpdated("yt-navigate-finish");
}

/**
 * Attach the YouTube-specific SPA navigation listener when available.
 */
function setupYouTubeNavigationListener(): void {
  document.addEventListener("yt-navigate-finish", handleYouTubeNavigation);
}

/**
 * Detach the YouTube SPA navigation listener.
 */
function teardownYouTubeNavigationListener(): void {
  document.removeEventListener("yt-navigate-finish", handleYouTubeNavigation);
}

/**
 * Re-scan existing videos and apply blur/sampling per current settings.
 */
export async function rescanAndApplyCurrentSettings(): Promise<void> {
  cachedContentSettings = await loadSettings();

  if (!isNudityProtectionActive(cachedContentSettings)) {
    stopAllSampling();
    clearAllFullVideoBlurs();
    resetAllAnalysisStates();
    console.info("[SafeView] Nudity protection off — sampling stopped, blur cleared.");
    return;
  }

  if (!isMonitorRunning) {
    startVideoMonitor();
  }

  const videos = Array.from(document.querySelectorAll("video"));
  for (const video of videos) {
    if (!isVideoVisibleInLayout(video)) {
      continue;
    }

    ensureVideoRegistered(video);
  }

  reconcilePrimaryCaptureLoop("settings-rescan");
  console.info(
    "[SafeView] Settings rescan complete — %s visible video(s), primary=%s",
    videos.length,
    primaryCaptureVideo ? "yes" : "no"
  );
}

/**
 * Apply latest settings immediately (no page refresh).
 *
 * @param reason - Diagnostic label from popup, storage, or navigation.
 */
export async function handleSettingsUpdated(reason: string): Promise<void> {
  console.info("[SafeView] SETTINGS_UPDATED in content script (%s)", reason);
  await rescanAndApplyCurrentSettings();
}

/**
 * Listen for chrome.storage settings changes (backup when tab message fails).
 */
function setupSettingsStorageListener(): void {
  if (settingsStorageListenerRegistered) {
    return;
  }

  settingsStorageListenerRegistered = true;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes[SETTINGS_STORAGE_KEY] === undefined) {
      return;
    }

    void handleSettingsUpdated("storage");
  });
}

/**
 * Route runtime messages (frame analysis done, settings updated).
 */
function setupRuntimeMessageListener(): void {
  if (runtimeMessageListenerRegistered) {
    return;
  }

  runtimeMessageListenerRegistered = true;

  chrome.runtime.onMessage?.addListener((message) => {
    if (!message || typeof message !== "object") {
      return;
    }

    const payload = message as {
      action?: string;
      videoId?: number;
      requestId?: number;
      decision?: string;
      reason?: string;
    };

    if (payload.action === MESSAGE_ACTION_FRAME_ANALYSIS_DONE) {
      if (typeof payload.videoId === "number") {
        const extended = payload as {
          videoId: number;
          requestId?: number;
          decision?: string;
          reason?: string;
          detected?: boolean;
          confidence?: number;
          action?: string;
          capturedVideoTime?: number;
          responseAgeMs?: number;
        };
        handleFrameAnalysisDone(
          extended.videoId,
          extended.requestId,
          extended.decision,
          extended.reason,
          {
            detected: extended.detected,
            confidence: extended.confidence,
            action: extended.action,
            capturedVideoTime: extended.capturedVideoTime,
            responseAgeMs: extended.responseAgeMs,
          }
        );
      }
      return;
    }

    if (payload.action === MESSAGE_ACTION_SETTINGS_UPDATED) {
      void handleSettingsUpdated(payload.reason ?? "message");
    }
  });
}

/**
 * Re-scan videos on SPA route changes (YouTube, TikTok, Netflix-like apps).
 */
function setupSpaNavigationListener(): void {
  if (spaNavigationHooked) {
    return;
  }

  spaNavigationHooked = true;

  const onRouteChange = (): void => {
    void handleSettingsUpdated("spa-navigation");
  };

  window.addEventListener("popstate", onRouteChange);

  const wrapHistoryMethod = (method: "pushState" | "replaceState"): void => {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History["pushState"]>) => {
      original(...args);
      onRouteChange();
    };
  };

  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");
}

/**
 * Start monitoring the page for <video> elements and sampling frames.
 */
export function startVideoMonitor(): void {
  if (isMonitorRunning) {
    return;
  }

  isMonitorRunning = true;
  monitorVideos();

  observer = new MutationObserver(handleMutations);
  const observeTarget = document.body ?? document.documentElement;
  observer.observe(observeTarget, {
    childList: true,
    subtree: true,
  });

  setupYouTubeNavigationListener();
  setupSpaNavigationListener();
  setupSettingsStorageListener();
  setupRuntimeMessageListener();
  seedYouTubeWatchVideoId();

  void loadSettings().then((settings) => {
    cachedContentSettings = settings;
    void rescanAndApplyCurrentSettings();
  });

  reconcilePrimaryCaptureLoop("monitor-start");
  console.info("[SafeView] Video monitor started.");
}

/**
 * Stop monitoring, clear intervals, and release tracked videos.
 */
export function stopVideoMonitor(): void {
  if (!isMonitorRunning) {
    return;
  }

  isMonitorRunning = false;

  if (observer) {
    observer.disconnect();
    observer = null;
  }

  teardownYouTubeNavigationListener();

  for (const video of [...videoIdToElement.values()]) {
    unregisterVideo(video, "monitor-stop");
  }

  videoIdToElement.clear();
  primaryCaptureVideo = null;
  console.info("[SafeView] Video monitor stopped.");
}

/**
 * Resolve a tracked video element by its stable id.
 */
export function getVideoById(videoId: number): HTMLVideoElement | undefined {
  return videoIdToElement.get(videoId);
}

/**
 * Return the tracked <video> with the largest on-screen area (YouTube main player).
 */
export function findPrimaryVisibleVideo(): HTMLVideoElement | undefined {
  let bestVideo: HTMLVideoElement | undefined;
  let bestArea = 0;
  let bestPlaying = false;

  for (const video of videoIdToElement.values()) {
    if (!isVideoVisibleInLayout(video)) {
      continue;
    }

    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    const isPlaying = !video.paused && !video.ended;

    if (
      area > bestArea ||
      (area === bestArea && isPlaying && !bestPlaying)
    ) {
      bestArea = area;
      bestVideo = video;
      bestPlaying = isPlaying;
    } else if (isPlaying && !bestPlaying && area >= bestArea * 0.85) {
      bestArea = area;
      bestVideo = video;
      bestPlaying = true;
    }
  }

  return bestVideo;
}

/**
 * Read tracking state for a video element.
 */
export function getVideoTrackState(
  video: HTMLVideoElement
): VideoTrackState | undefined {
  return trackedVideos.get(video);
}
