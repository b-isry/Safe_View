// SafeView — videoMonitor.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Find <video> elements via MutationObserver and sample frames at ≤2 FPS.

/** Minimum milliseconds between frame samples per video (≤ 2 FPS). */
export const SAMPLE_INTERVAL_MS = 500;

/** MIME type passed to canvas.toBlob for frame upload. */
const JPEG_MIME_TYPE = "image/jpeg";

/** JPEG quality for canvas.toBlob frame capture (higher preserves detail for ViT). */
const JPEG_QUALITY = 0.92;

/** Max canvas width before JPEG encode (model resizes to 224×224). */
const CAPTURE_MAX_WIDTH_PX = 480;

/** Reject near-black frames (transitions, fades, failed decode). */
const MIN_FRAME_LUMINANCE = 12;

/** Chunk size for fast base64 encoding (avoids spread-arg limits on large buffers). */
const BASE64_CHUNK_SIZE = 0x8000;

/** chrome.runtime message action sent to the service worker with a frame blob. */
export const MESSAGE_ACTION_FRAME_SAMPLE = "FRAME_SAMPLE";

/** Minimum layout size (px) for a video to count as the visible player. */
const MIN_VISIBLE_LAYOUT_PX = 200;

/**
 * Per-video sampling state stored in the WeakMap.
 */
export interface VideoTrackState {
  /** Stable id for messaging between content script and service worker. */
  videoId: number;
  /** Monotonic timestamp of the last successful sample (performance.now()). */
  lastSampleAt: number;
  /** Active interval handle for this video, or null when using rVFC or stopped. */
  intervalId: ReturnType<typeof setInterval> | null;
  /** True while an async capture is in flight (prevents overlapping samples). */
  isCapturing: boolean;
  /** Last video.currentTime sent — skips duplicate frames at the same timestamp. */
  lastSampledTime: number;
  /** True when sampling uses requestVideoFrameCallback instead of setInterval. */
  usesVideoFrameCallback: boolean;
}

const trackedVideos = new WeakMap<HTMLVideoElement, VideoTrackState>();
const videoIdToElement = new Map<number, HTMLVideoElement>();

let nextVideoId = 1;
let observer: MutationObserver | null = null;
let isMonitorRunning = false;

/**
 * True when the browser supports requestVideoFrameCallback on video elements.
 */
function supportsVideoFrameCallback(video: HTMLVideoElement): boolean {
  return typeof video.requestVideoFrameCallback === "function";
}

/**
 * Scan a DOM subtree for <video> elements and register any new ones.
 *
 * @param root - Node to scan (element or document fragment).
 */
function scanForVideos(root: Element | Document | DocumentFragment): void {
  if (root instanceof HTMLVideoElement) {
    registerVideo(root);
  }

  if ("querySelectorAll" in root) {
    root.querySelectorAll("video").forEach((video) => {
      registerVideo(video);
    });
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

  const videoId = nextVideoId++;
  const state: VideoTrackState = {
    videoId,
    lastSampleAt: 0,
    intervalId: null,
    isCapturing: false,
    lastSampledTime: -1,
    usesVideoFrameCallback: false,
  };

  trackedVideos.set(video, state);
  videoIdToElement.set(videoId, video);
  startSampling(video, state);
}

/**
 * Stop sampling and release tracking for a removed video element.
 *
 * @param video - HTMLVideoElement that left the DOM.
 */
function unregisterVideo(video: HTMLVideoElement): void {
  const state = trackedVideos.get(video);
  if (!state) {
    return;
  }

  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }

  state.usesVideoFrameCallback = false;
  videoIdToElement.delete(state.videoId);
  trackedVideos.delete(video);
}

/**
 * Schedule frame sampling via requestVideoFrameCallback (decoded-frame timing).
 *
 * @param video - Target video element.
 */
function startVideoFrameCallbackSampling(video: HTMLVideoElement): void {
  const onVideoFrame = (): void => {
    if (!trackedVideos.has(video)) {
      return;
    }

    void sampleFrame(video);
    video.requestVideoFrameCallback(onVideoFrame);
  };

  video.requestVideoFrameCallback(onVideoFrame);
}

/**
 * Begin the 500 ms gated sampling loop for one video.
 *
 * @param video - Target video element.
 * @param state - WeakMap entry for the video.
 */
function startSampling(video: HTMLVideoElement, state: VideoTrackState): void {
  if (state.intervalId !== null || state.usesVideoFrameCallback) {
    return;
  }

  if (supportsVideoFrameCallback(video)) {
    state.usesVideoFrameCallback = true;
    startVideoFrameCallbackSampling(video);
    return;
  }

  state.intervalId = window.setInterval(() => {
    void sampleFrame(video);
  }, SAMPLE_INTERVAL_MS);
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
 *
 * @param context - 2D canvas context after drawImage.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @returns True when average luminance is below MIN_FRAME_LUMINANCE.
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
 * BR-02: canvas.width and canvas.height are reset to 0 in a finally block
 * immediately after toBlob resolves — before any network or messaging work.
 *
 * @param video - HTMLVideoElement with ready frame data.
 * @returns JPEG Blob, or null if capture or encoding failed.
 */
async function captureVideoFrameToBlob(
  video: HTMLVideoElement
): Promise<Blob | null> {
  const { width, height } = captureDimensions(video.videoWidth, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  try {
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, width, height);

    if (isFrameLikelyBlank(context, canvas.width, canvas.height)) {
      return null;
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, JPEG_MIME_TYPE, JPEG_QUALITY);
    });

    return blob;
  } catch {
    console.warn(
      "[SafeView] Frame capture skipped (tainted canvas / CORS). Detection disabled for this source."
    );
    return null;
  } finally {
    purgeCanvas(canvas);
  }
}

/**
 * Release offscreen canvas memory per BR-02.
 *
 * @param canvas - Canvas to reset immediately after toBlob completes.
 */
function purgeCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Capture one JPEG frame and send it to the service worker when the gate allows.
 *
 * Flow: drawImage → blank check → toBlob(jpeg, 0.92) → purge canvas → sendMessage.
 *
 * @param video - HTMLVideoElement to sample.
 */
async function sampleFrame(video: HTMLVideoElement): Promise<void> {
  const state = trackedVideos.get(video);
  if (!state || state.isCapturing) {
    return;
  }

  const now = performance.now();
  if (now - state.lastSampleAt < SAMPLE_INTERVAL_MS) {
    return;
  }

  const primaryVideo = findPrimaryVisibleVideo();
  if (primaryVideo && primaryVideo !== video) {
    return;
  }

  if (video.paused || video.seeking) {
    return;
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  if (video.videoWidth === 0 || video.videoHeight === 0) {
    return;
  }

  if (video.currentTime === state.lastSampledTime) {
    return;
  }

  state.isCapturing = true;

  try {
    const blob = await captureVideoFrameToBlob(video);
    if (!blob) {
      return;
    }

    const capturedAt = performance.now();
    console.info(
      "[SafeView][Latency] frame captured video=%s size=%s native=%sx%s",
      state.videoId,
      blob.size,
      video.videoWidth,
      video.videoHeight
    );

    state.lastSampleAt = now;
    state.lastSampledTime = video.currentTime;
    await sendFrameToServiceWorker(state.videoId, blob, capturedAt);
  } catch (error) {
    console.error("[SafeView] Frame sampling failed:", error);
  } finally {
    state.isCapturing = false;
  }
}

/**
 * Encode JPEG bytes as base64 for chrome.runtime.sendMessage (Blob/ArrayBuffer
 * do not round-trip reliably through MV3 structured clone).
 *
 * @param buffer - Raw JPEG bytes from canvas.toBlob.
 * @returns Base64 string safe for message passing.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * Send a frame blob to the MV3 service worker for backend analysis.
 *
 * @param videoId - Stable id for this video element.
 * @param frame - JPEG blob; never logged or persisted in the content script.
 */
async function sendFrameToServiceWorker(
  videoId: number,
  frame: Blob,
  capturedAt: number
): Promise<void> {
  try {
    const encodeStarted = performance.now();
    const frameBase64 = arrayBufferToBase64(await frame.arrayBuffer());
    const encodeMs = Math.round(performance.now() - encodeStarted);
    const sentAt = performance.now();

    console.info(
      "[SafeView][Latency] message sent video=%s encodeMs=%s base64Len=%s",
      videoId,
      encodeMs,
      frameBase64.length
    );

    void chrome.runtime
      .sendMessage({
        action: MESSAGE_ACTION_FRAME_SAMPLE,
        videoId,
        frameBase64,
        frameMimeType: frame.type || JPEG_MIME_TYPE,
        contentBuild: chrome.runtime.getManifest().version,
        capturedAt,
        sentAt,
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
 *
 * @param mutations - DOM mutation list from the observer.
 */
function handleMutations(mutations: MutationRecord[]): void {
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
        unregisterVideo(node);
      } else if (node instanceof Element) {
        node.querySelectorAll("video").forEach((video) => {
          unregisterVideo(video);
        });
      }
    });
  }
}

/**
 * Re-scan the document after YouTube SPA navigation completes.
 */
function handleYouTubeNavigation(): void {
  console.info("[SafeView] YouTube navigation finished — rescanning for videos.");
  scanForVideos(document);
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
  scanForVideos(document);

  observer = new MutationObserver(handleMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  setupYouTubeNavigationListener();
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

  for (const video of videoIdToElement.values()) {
    unregisterVideo(video);
  }

  videoIdToElement.clear();
  console.info("[SafeView] Video monitor stopped.");
}

/**
 * Resolve a tracked video element by its stable id.
 *
 * @param videoId - Id assigned at registration time.
 * @returns HTMLVideoElement or undefined if untracked.
 */
export function getVideoById(videoId: number): HTMLVideoElement | undefined {
  return videoIdToElement.get(videoId);
}

/**
 * Return the tracked <video> with the largest on-screen area (YouTube main player).
 *
 * @returns Visible player element, or undefined if none qualify.
 */
export function findPrimaryVisibleVideo(): HTMLVideoElement | undefined {
  let bestVideo: HTMLVideoElement | undefined;
  let bestArea = 0;

  for (const video of videoIdToElement.values()) {
    if (!video.isConnected || video.videoWidth === 0 || video.videoHeight === 0) {
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
 *
 * @param video - HTMLVideoElement to look up.
 * @returns VideoTrackState or undefined if not tracked.
 */
export function getVideoTrackState(
  video: HTMLVideoElement
): VideoTrackState | undefined {
  return trackedVideos.get(video);
}
