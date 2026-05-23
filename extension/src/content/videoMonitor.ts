// SafeView — videoMonitor.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Find <video> elements via MutationObserver and sample frames for nudity detection.
// CSP-safe: native DOM only — no injected <script> tags or page-context hooks.

import {
  onVideoTrackedForSpeakerSuppression,
  prepareVideoCrossOrigin,
  startSubtitleMonitor,
  stopSubtitleMonitor,
} from "./audioMonitor";
import {
  onYouTubeWatchIdBoundary,
  seedYouTubeWatchVideoId,
} from "./pipelineNavigation";
/** Active visible tab: ~10 FPS sampling gate. */
export const SAMPLE_INTERVAL_ACTIVE_MS = 100;

/** Paused video: lower sampling rate. */
export const SAMPLE_INTERVAL_PAUSED_MS = 2000;

/** Hidden document tab: lower sampling rate. */
export const SAMPLE_INTERVAL_HIDDEN_MS = 2000;

/** @deprecated Use SAMPLE_INTERVAL_ACTIVE_MS — kept for tests/imports. */
export const SAMPLE_INTERVAL_MS = SAMPLE_INTERVAL_ACTIVE_MS;

/** Warn when JPEG encode (or main-thread queue wait) exceeds this (ms). */
export const ENCODE_STALL_WARN_MS = 200;

/** MIME type passed to canvas.toBlob for frame upload. */
const JPEG_MIME_TYPE = "image/jpeg";

/** JPEG quality for canvas.toBlob (model resizes to 224×224). */
export const JPEG_QUALITY = 0.65;

/** Max canvas width before JPEG encode (matches model input scale). */
export const CAPTURE_MAX_WIDTH_PX = 256;

/** Reject near-black frames (transitions, fades, failed decode). */
const MIN_FRAME_LUMINANCE = 12;

/** chrome.runtime message action sent to the service worker with a frame blob. */
export const MESSAGE_ACTION_FRAME_SAMPLE = "FRAME_SAMPLE";

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
}

const trackedVideos = new WeakMap<HTMLVideoElement, VideoTrackState>();
const videoIdToElement = new Map<number, HTMLVideoElement>();

let nextVideoId = 1;
let observer: MutationObserver | null = null;
let isMonitorRunning = false;

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
  if (video.dataset[SAFE_VIEW_TRACKED_DATASET] === "true") {
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
    }
  }

  if (!primary) {
    primaryCaptureVideo = null;
    return;
  }

  const state = trackedVideos.get(primary);
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
  video.removeEventListener("loadedmetadata", state.onMetadataLoaded);
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
  }, SAMPLE_INTERVAL_ACTIVE_MS);

  console.info(
    "[SafeView][Capture] INTERVAL START video=%s session=%s ms=%s",
    state.videoId,
    session,
    SAMPLE_INTERVAL_ACTIVE_MS
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
  captureSession: number
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

  const intervalMs = getSampleIntervalMs(video);
  const now = performance.now();
  if (now - state.lastSampleAt < intervalMs) {
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

  if (!document.hidden && !video.paused && video.currentTime === state.lastSampledTime) {
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

    await sendFrameToServiceWorker(
      after.videoId,
      result.blob,
      capturedAt,
      after.frameSeq,
      result.captureMs,
      result.encodeMs,
      captureSession,
      seq
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
  captureSeq: number
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
  monitorVideos();
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
  seedYouTubeWatchVideoId();
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

  for (const video of videoIdToElement.values()) {
    if (!video.isConnected) {
      continue;
    }

    const rect = video.getBoundingClientRect();
    if (rect.width < MIN_VISIBLE_LAYOUT_PX || rect.height < MIN_VISIBLE_LAYOUT_PX) {
      continue;
    }

    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      bestVideo = video;
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
