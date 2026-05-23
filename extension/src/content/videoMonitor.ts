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
} from "./fullVideoBlur";
import {
  onYouTubeWatchIdBoundary,
  seedYouTubeWatchVideoId,
} from "./pipelineNavigation";

/** Active visible tab: ~25 FPS sampling gate. */
export const SAMPLE_INTERVAL_MS = 40;

/** @deprecated Alias for SAMPLE_INTERVAL_MS — kept for tests/imports. */
export const SAMPLE_INTERVAL_ACTIVE_MS = SAMPLE_INTERVAL_MS;

/** Paused video: lower sampling rate. */
export const SAMPLE_INTERVAL_PAUSED_MS = 2000;

/** Hidden document tab: lower sampling rate. */
export const SAMPLE_INTERVAL_HIDDEN_MS = 2000;

/** Warn when JPEG encode (or main-thread queue wait) exceeds this (ms). */
export const ENCODE_STALL_WARN_MS = 200;

/** MIME type passed to canvas.toBlob for frame upload. */
const JPEG_MIME_TYPE = "image/jpeg";

/** JPEG quality for canvas.toBlob (model resizes to 224×224). */
export const JPEG_QUALITY = 0.45;

/** Max canvas width before JPEG encode (matches model input scale). */
export const CAPTURE_MAX_WIDTH_PX = 224;

/** Delay before the first frame sample after registration (0 = immediate). */
const FIRST_SAMPLE_DELAY_MS = 0;

/** Retry interval when the first sample has no decoded frame yet (ms). */
const FIRST_SAMPLE_RETRY_MS = 80;

/** Mark in-flight analysis stale after this duration (ms). */
const MAX_PENDING_ANALYSIS_MS = 1200;

/** Keep blur when backend analysis exceeds this duration (ms). */
const BACKEND_TIMEOUT_MS = 1000;

/** Reject near-black frames (transitions, fades, failed decode). */
const MIN_FRAME_LUMINANCE = 12;

/** chrome.runtime message action sent to the service worker with a frame blob. */
export const MESSAGE_ACTION_FRAME_SAMPLE = "FRAME_SAMPLE";

/** Service worker → content script: one frame analysis cycle finished. */
export const MESSAGE_ACTION_FRAME_ANALYSIS_DONE = "FRAME_ANALYSIS_DONE";

/** Downscaled scene snapshot width (pixels). */
const SCENE_SNAPSHOT_WIDTH = 32;

/** Downscaled scene snapshot height (pixels). */
const SCENE_SNAPSHOT_HEIGHT = 18;

/** Average per-channel delta that counts as a major scene change. */
const SCENE_CHANGE_PIXEL_THRESHOLD = 28;

/** Playback jump larger than this triggers a fresh blur cycle (seconds). */
const PLAYBACK_JUMP_SECONDS = 1.5;

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

/**
 * Per-video backend analysis tracking (frame queue protection).
 */
export type VideoAnalysisState = {
  isAnalyzing: boolean;
  lastAnalysisStartedAt: number;
  requestId: number;
  firstDecisionMade: boolean;
  unsafeSeen: boolean;
  safeStreak: number;
  unsafeLockUntil: number;
  /** True when blur is cleared and monitoring continues. */
  isClear: boolean;
  /** Downscaled RGBA snapshot for scene-change detection. */
  lastSceneSnapshot: Uint8ClampedArray | null;
  /** Last observed playback time (seek detection). */
  lastVideoTime: number;
  /** Last observed media src (route / video swap detection). */
  lastSrc: string;
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
  intervalId: ReturnType<typeof setInterval> | null;
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
  analysisTimeoutId: ReturnType<typeof setTimeout> | null;
  /** Retry timer when the first sample has no frame data yet. */
  firstSampleRetryId: ReturnType<typeof setTimeout> | null;
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

  return SAMPLE_INTERVAL_ACTIVE_MS;
}

/**
 * Create default per-video backend analysis state.
 */
function createAnalysisState(): VideoAnalysisState {
  return {
    isAnalyzing: false,
    lastAnalysisStartedAt: 0,
    requestId: 0,
    firstDecisionMade: false,
    unsafeSeen: false,
    safeStreak: 0,
    unsafeLockUntil: 0,
    isClear: false,
    lastSceneSnapshot: null,
    lastVideoTime: -1,
    lastSrc: "",
  };
}

/**
 * Capture a tiny RGBA snapshot for lightweight scene-change detection.
 */
function captureSceneSnapshot(video: HTMLVideoElement): Uint8ClampedArray | null {
  if (!canCaptureFrame(video)) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = SCENE_SNAPSHOT_WIDTH;
  canvas.height = SCENE_SNAPSHOT_HEIGHT;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  try {
    ctx.drawImage(video, 0, 0, SCENE_SNAPSHOT_WIDTH, SCENE_SNAPSHOT_HEIGHT);
    return ctx.getImageData(0, 0, SCENE_SNAPSHOT_WIDTH, SCENE_SNAPSHOT_HEIGHT).data;
  } catch {
    return null;
  } finally {
    purgeCanvas(canvas);
  }
}

/**
 * True when the current snapshot differs strongly from the previous one.
 */
function hasMajorSceneChange(
  previous: Uint8ClampedArray | null,
  current: Uint8ClampedArray
): boolean {
  if (!previous || previous.length !== current.length) {
    return previous !== null;
  }

  let channelSum = 0;
  const pixels = previous.length / 4;
  for (let i = 0; i < previous.length; i += 4) {
    channelSum +=
      Math.abs(current[i] - previous[i]) +
      Math.abs(current[i + 1] - previous[i + 1]) +
      Math.abs(current[i + 2] - previous[i + 2]);
  }

  return channelSum / pixels / 3 >= SCENE_CHANGE_PIXEL_THRESHOLD;
}

/**
 * Reset analysis after seek, src change, or route swap — blur and rescan.
 */
function resetForPlaybackBoundary(
  video: HTMLVideoElement,
  state: VideoTrackState,
  reason: string
): void {
  state.analysis.firstDecisionMade = false;
  state.analysis.safeStreak = 0;
  state.analysis.unsafeSeen = false;
  state.analysis.unsafeLockUntil = 0;
  state.analysis.isClear = false;
  state.analysis.lastSceneSnapshot = null;
  applyImmediateLocalBlur(video);

  console.info(
    "[SafeView][Capture] BOUNDARY RESET video=%s reason=%s",
    state.videoId,
    reason
  );
}

/**
 * Detect seek jumps and src changes; blur immediately when they occur.
 *
 * @returns True when a boundary reset was applied.
 */
function checkPlaybackBoundary(video: HTMLVideoElement, state: VideoTrackState): boolean {
  const src = video.currentSrc || video.src || "";
  const time = video.currentTime;
  let jumped = false;

  if (state.analysis.lastVideoTime >= 0) {
    const delta = Math.abs(time - state.analysis.lastVideoTime);
    jumped =
      delta > PLAYBACK_JUMP_SECONDS || time < state.analysis.lastVideoTime - 0.25;
  }

  const srcChanged =
    state.analysis.lastSrc.length > 0 &&
    src.length > 0 &&
    src !== state.analysis.lastSrc;

  state.analysis.lastVideoTime = time;
  if (src.length > 0) {
    state.analysis.lastSrc = src;
  }

  if (jumped || srcChanged) {
    resetForPlaybackBoundary(video, state, jumped ? "seek-jump" : "src-change");
    return true;
  }

  return false;
}

/**
 * When the video is clear, blur immediately on a major visual scene change.
 *
 * @returns True when scene-change preemptive blur was applied.
 */
function maybeHandleSceneChange(
  video: HTMLVideoElement,
  state: VideoTrackState
): boolean {
  if (!state.analysis.isClear) {
    return false;
  }

  const snapshot = captureSceneSnapshot(video);
  if (!snapshot) {
    return false;
  }

  const sceneChanged = hasMajorSceneChange(state.analysis.lastSceneSnapshot, snapshot);
  state.analysis.lastSceneSnapshot = snapshot;

  if (!sceneChanged) {
    return false;
  }

  state.analysis.firstDecisionMade = false;
  state.analysis.safeStreak = 0;
  state.analysis.isClear = false;
  applyImmediateLocalBlur(video);

  console.info(
    "[SafeView][Capture] SCENE CHANGE video=%s — temporary blur",
    state.videoId
  );
  return true;
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
}

/**
 * Handle FRAME_ANALYSIS_DONE from the service worker.
 */
function handleFrameAnalysisDone(
  videoId: number,
  requestId?: number,
  decision?: string,
  reason?: string
): void {
  const video = videoIdToElement.get(videoId);
  if (!video) {
    return;
  }

  const state = trackedVideos.get(video);
  if (!state) {
    return;
  }

  const resolvedRequestId = requestId ?? state.analysis.requestId;
  if (resolvedRequestId > 0 && resolvedRequestId < state.analysis.requestId) {
    return;
  }

  markAnalysisComplete(state, resolvedRequestId);

  const primary = findPrimaryVisibleVideo();
  if (video !== primary) {
    return;
  }

  if (decision === "CLEAR") {
    state.analysis.unsafeSeen = false;
    state.analysis.safeStreak = 0;
    state.analysis.unsafeLockUntil = 0;
    state.analysis.firstDecisionMade = true;
    state.analysis.isClear = true;
    clearImmediateLocalBlur(video);
    const snapshot = captureSceneSnapshot(video);
    if (snapshot) {
      state.analysis.lastSceneSnapshot = snapshot;
    }
  } else if (decision === "BLUR") {
    state.analysis.isClear = false;
    state.analysis.safeStreak = 0;
    state.analysis.firstDecisionMade = true;
    if (reason === "unsafe") {
      state.analysis.unsafeSeen = true;
    }
    applyImmediateLocalBlur(video);
  } else if (
    decision === "HOLD" &&
    reason === "building_safe_streak" &&
    state.analysis.unsafeSeen
  ) {
    state.analysis.safeStreak += 1;
  }

  if (isNudityProtectionActiveCached() && video === primary) {
    void sampleFrame(video, state.captureSession, true);
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

  if (FIRST_SAMPLE_DELAY_MS === 0) {
    tryFirstSample();
  } else {
    window.setTimeout(tryFirstSample, FIRST_SAMPLE_DELAY_MS);
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
  state.analysis = createAnalysisState();
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
    if (findPrimaryVisibleVideo() === video) {
      applyImmediateLocalBlur(video);
      triggerImmediateFirstSample(video);
    } else {
      clearImmediateLocalBlur(video);
    }
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
  state.isCapturing = false;

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
      clearImmediateLocalBlur(video);
    }
  }

  if (!primary) {
    primaryCaptureVideo = null;
    return;
  }

  applyImmediateLocalBlur(primary);
  const primaryState = trackedVideos.get(primary);
  if (primaryState) {
    scheduleFirstSample(primary, primaryState);
  }

  const state = primaryState;
  if (!state) {
    primaryCaptureVideo = null;
    return;
  }

  if (primaryCaptureVideo === primary && state.usesVideoFrameCallback) {
    return;
  }

  if (primaryCaptureVideo === primary && state.intervalId !== null) {
    return;
  }

  primaryCaptureVideo = primary;
  startSampling(primary, state, reason);
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
    analysisTimeoutId: null,
    firstSampleRetryId: null,
  };

  trackedVideos.set(video, state);
  videoIdToElement.set(videoId, video);
  video.addEventListener("loadedmetadata", state.onMetadataLoaded);
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
  clearImmediateLocalBlur(video);
  video.removeEventListener("loadedmetadata", state.onMetadataLoaded);
  teardownFirstSampleListeners(video, state);
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

    void sampleFrame(video, session);

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
function startSampling(
  video: HTMLVideoElement,
  state: VideoTrackState,
  reason: string
): void {
  if (state.intervalId !== null || state.usesVideoFrameCallback) {
    return;
  }

  const session = state.captureSession;

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

  state.intervalId = window.setInterval(() => {
    const current = trackedVideos.get(video);
    if (!current || current.captureSession !== session) {
      return;
    }

    console.debug(
      "[SafeView][Capture] INTERVAL FIRE video=%s session=%s",
      state.videoId,
      session
    );
    void sampleFrame(video, session);
  }, SAMPLE_INTERVAL_MS);

  console.info(
    "[SafeView][Capture] INTERVAL START video=%s session=%s ms=%s",
    state.videoId,
    session,
    SAMPLE_INTERVAL_MS
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
  videoHeight: number
): { width: number; height: number } {
  if (videoWidth <= CAPTURE_MAX_WIDTH_PX) {
    return { width: videoWidth, height: videoHeight };
  }

  const scale = CAPTURE_MAX_WIDTH_PX / videoWidth;
  return {
    width: CAPTURE_MAX_WIDTH_PX,
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
  canvasHeight: number
): Promise<{
  blob: Blob;
  captureMs: number;
  encodeMs: number;
} | null> {
  const captureStarted = performance.now();
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  activeCaptureCount += 1;

  try {
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, canvasWidth, canvasHeight);

    if (isFrameLikelyBlank(context, canvas.width, canvas.height)) {
      return null;
    }

    const captureMs = Math.round(performance.now() - captureStarted);
    const encodeStarted = performance.now();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, JPEG_MIME_TYPE, JPEG_QUALITY);
    });

    const encodeMs = Math.round(performance.now() - encodeStarted);

    if (!blob) {
      return null;
    }

    if (encodeMs > ENCODE_STALL_WARN_MS) {
      console.warn(
        "[SafeView][Capture] ENCODE STALL encodeMs=%s activeCaptures=%s canvas=%sx%s native=%sx%s",
        encodeMs,
        activeCaptureCount,
        canvasWidth,
        canvasHeight,
        video.videoWidth,
        video.videoHeight
      );
    }

    return { blob, captureMs, encodeMs };
  } catch {
    console.warn(
      "[SafeView] Frame capture skipped (tainted canvas / CORS). Detection disabled for this source."
    );
    return null;
  } finally {
    activeCaptureCount = Math.max(0, activeCaptureCount - 1);
    purgeCanvas(canvas);
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

  if (primaryCaptureVideo !== video) {
    return;
  }

  if (state.isCapturing) {
    console.debug(
      "[SafeView][Capture] SKIP overlap video=%s session=%s",
      state.videoId,
      captureSession
    );
    return;
  }

  const now = performance.now();

  if (state.analysis.isAnalyzing) {
    const pendingMs = now - state.analysis.lastAnalysisStartedAt;
    if (pendingMs < MAX_PENDING_ANALYSIS_MS && !immediate) {
      console.debug(
        "[SafeView][Capture] SKIP pending analysis video=%s request=%s pendingMs=%s",
        state.videoId,
        state.analysis.requestId,
        Math.round(pendingMs)
      );
      return;
    }

    console.info(
      "[SafeView][Capture] STALE analysis video=%s request=%s pendingMs=%s",
      state.videoId,
      state.analysis.requestId,
      Math.round(pendingMs)
    );
    state.analysis.isAnalyzing = false;
    clearAnalysisTimeout(state);
  }

  if (canCaptureFrame(video)) {
    const boundaryReset = checkPlaybackBoundary(video, state);
    const sceneChanged = !boundaryReset && maybeHandleSceneChange(video, state);
    if (boundaryReset || sceneChanged) {
      immediate = true;
    }
  }

  const intervalMs = getSampleIntervalMs(video);
  if (!immediate && now - state.lastSampleAt < intervalMs) {
    return;
  }

  if (video.seeking) {
    return;
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  if (video.videoWidth === 0 || video.videoHeight === 0) {
    return;
  }

  if (
    !immediate &&
    !document.hidden &&
    !video.paused &&
    video.currentTime === state.lastSampledTime
  ) {
    return;
  }

  const { width: canvasWidth, height: canvasHeight } = captureDimensions(
    video.videoWidth,
    video.videoHeight
  );

  state.isCapturing = true;
  const seq = state.frameSeq + 1;

  console.info(
    "[SafeView][Capture] START video=%s session=%s seq=%s canvas=%sx%s native=%sx%s active=%s",
    state.videoId,
    captureSession,
    seq,
    canvasWidth,
    canvasHeight,
    video.videoWidth,
    video.videoHeight,
    activeCaptureCount
  );

  try {
    const result = await captureVideoFrameToBlob(video, canvasWidth, canvasHeight);

    if (!result) {
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

    const capturedAt = Date.now();
    after.frameSeq = seq;

    console.info(
      "[SafeView][Latency] capture video=%s session=%s seq=%s captureMs=%s encodeMs=%s size=%s canvas=%sx%s native=%sx%s intervalMs=%s activeCaptures=%s",
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
      intervalMs,
      activeCaptureCount
    );

    after.lastSampleAt = now;
    after.lastSampledTime = video.currentTime;

    after.analysis.requestId += 1;
    const requestId = after.analysis.requestId;
    after.analysis.isAnalyzing = true;
    after.analysis.lastAnalysisStartedAt = now;
    clearAnalysisTimeout(after);
    after.analysisTimeoutId = window.setTimeout(() => {
      if (after.analysis.requestId === requestId && after.analysis.isAnalyzing) {
        after.analysis.isAnalyzing = false;
        if (after.analysis.isClear) {
          console.warn(
            "[SafeView][Capture] BACKEND TIMEOUT video=%s request=%s — retry (video clear)",
            after.videoId,
            requestId
          );
          void sampleFrame(video, captureSession, true);
        } else {
          console.warn(
            "[SafeView][Capture] BACKEND TIMEOUT video=%s request=%s — keeping blur",
            after.videoId,
            requestId
          );
        }
      }
    }, BACKEND_TIMEOUT_MS);

    await sendFrameToServiceWorker(
      after.videoId,
      result.blob,
      capturedAt,
      after.frameSeq,
      result.captureMs,
      result.encodeMs,
      captureSession,
      seq,
      requestId
    );
  } catch (error) {
    console.error("[SafeView] Frame sampling failed:", error);
  } finally {
    const current = trackedVideos.get(video);
    if (current && current.captureSession === captureSession) {
      current.isCapturing = false;
    }

    console.info(
      "[SafeView][Capture] END video=%s session=%s seq=%s activeCaptures=%s",
      state.videoId,
      captureSession,
      seq,
      activeCaptureCount
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
        frameMimeType: frame.type || JPEG_MIME_TYPE,
        contentBuild: chrome.runtime.getManifest().version,
        capturedAt,
        sentAt,
        frameSeq,
        requestId,
        captureMs,
        encodeMs,
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
      reason?: string;
    };

    if (payload.action === MESSAGE_ACTION_FRAME_ANALYSIS_DONE) {
      if (typeof payload.videoId === "number") {
        const framePayload = message as {
          decision?: string;
          reason?: string;
        };
        handleFrameAnalysisDone(
          payload.videoId,
          payload.requestId,
          framePayload.decision,
          framePayload.reason
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
