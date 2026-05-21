// SafeView — blurManager.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Apply and remove full-video blur on BLUR / CLEAR messages from the service worker.

import {
  findPrimaryVisibleVideo,
  getVideoById,
} from "./videoMonitor";

/** Full-video blur radius per master prompt (px). */
export const BLUR_RADIUS_PX = 24;

/** CSS filter value applied to the entire <video> element. */
export const BLUR_FILTER = `blur(${BLUR_RADIUS_PX}px)`;

/** Backdrop blur for sites where <video> filter is not visible (e.g. YouTube). */
export const BLUR_BACKDROP = `blur(${BLUR_RADIUS_PX}px)`;

/** Transition duration when blur is applied or removed (seconds). */
export const BLUR_TRANSITION_SECONDS = 0.15;

/** CSS transition for filter changes. */
export const BLUR_TRANSITION = `filter ${BLUR_TRANSITION_SECONDS}s ease`;

/** Minimum time blur stays on after BLUR (matches BR-05 mute duration). */
export const MIN_BLUR_HOLD_MS = 1500;

/** Consecutive CLEAR messages required before unblur (reduces flicker). */
export const CLEAR_STREAK_REQUIRED = 3;

/** DOM class for the full-video blur overlay layer. */
export const BLUR_OVERLAY_CLASS = "safeview-blur-overlay";

/** Frosted overlay tint when backdrop-filter alone is insufficient (YouTube). */
export const BLUR_OVERLAY_TINT = "rgba(13, 27, 42, 0.72)";

/** Service worker → content script: apply blur to a video. */
export const MESSAGE_ACTION_BLUR = "BLUR";

/** Service worker → content script: remove blur from a video. */
export const MESSAGE_ACTION_CLEAR = "CLEAR";

/**
 * Incoming blur command from the service worker.
 */
export interface BlurCommandMessage {
  action: typeof MESSAGE_ACTION_BLUR | typeof MESSAGE_ACTION_CLEAR;
  videoId: number;
  capturedAt?: number;
  sentAt?: number;
  swReceivedAt?: number;
  backendDoneAt?: number;
}

/**
 * Saved inline styles restored on CLEAR.
 */
interface BlurRestoreState {
  originalFilter: string;
  originalTransition: string;
}

const blurredStyles = new WeakMap<HTMLVideoElement, BlurRestoreState>();
const blurOverlays = new WeakMap<HTMLVideoElement, HTMLDivElement>();
const blurredPlayerHosts = new WeakMap<HTMLVideoElement, BlurRestoreState>();
const blurredVideoSet = new Set<HTMLVideoElement>();

let removalObserver: MutationObserver | null = null;
let isBlurManagerInitialized = false;
let blurHoldUntil = 0;
let consecutiveClearCount = 0;
let overlaySyncHandle: number | null = null;

/** Session cdc754 — blur overlay diagnostics. */
function debugBlurLog(
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string
): void {
  if (typeof fetch === "undefined") {
    return;
  }

  // #region agent log
  fetch("http://127.0.0.1:7640/ingest/54f2aeff-4399-4b9d-ae56-da0825d96b38", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "cdc754",
    },
    body: JSON.stringify({
      sessionId: "cdc754",
      runId: "overlay-fix",
      hypothesisId,
      location: "blurManager.ts",
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

/**
 * True on YouTube watch pages where <video> CSS filter is often not visible.
 */
function shouldUseBlurOverlay(): boolean {
  return /(^|\.)youtube\.com$/i.test(window.location.hostname);
}

/**
 * YouTube wraps the real player in #movie_player — blur this host when present.
 *
 * @param video - Target HTMLVideoElement.
 * @returns Player container element, or null on non-YouTube pages.
 */
function findYouTubePlayerHost(video: HTMLVideoElement): HTMLElement | null {
  const host =
    video.closest("#movie_player") ?? video.closest(".html5-video-player");
  return host instanceof HTMLElement ? host : null;
}

/**
 * Pick the element that should receive blur (largest visible player wins).
 *
 * @param videoId - Id from the service worker BLUR/CLEAR command.
 * @returns Target video, or undefined.
 */
function resolveBlurTarget(videoId: number): HTMLVideoElement | undefined {
  const byId = getVideoById(videoId);
  if (!byId) {
    return undefined;
  }

  if (!byId.isConnected) {
    clearBlurForElement(byId);
    return undefined;
  }

  const primary = findPrimaryVisibleVideo();
  if (primary) {
    return primary;
  }

  return byId;
}

/**
 * Returns true while a recent BLUR is within the minimum hold window.
 */
function isBlurHoldActive(): boolean {
  return Date.now() < blurHoldUntil;
}

/**
 * True when the overlay is anchored inside the YouTube player container.
 *
 * @param overlay - Blur overlay element.
 * @returns True if parent is the YouTube movie player.
 */
function isPlayerHostedOverlay(overlay: HTMLDivElement): boolean {
  const parent = overlay.parentElement;
  return (
    parent instanceof HTMLElement &&
    (parent.id === "movie_player" || parent.classList.contains("html5-video-player"))
  );
}

/**
 * Position the overlay over the video's on-screen bounds.
 *
 * @param video - Target HTMLVideoElement.
 * @param overlay - Overlay div to align.
 */
function syncOverlayToVideo(video: HTMLVideoElement, overlay: HTMLDivElement): void {
  if (isPlayerHostedOverlay(overlay)) {
    overlay.style.display = "block";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    return;
  }

  const rect = video.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    overlay.style.display = "none";
    return;
  }

  overlay.style.display = "block";
  overlay.style.left = `${rect.left}px`;
  overlay.style.top = `${rect.top}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

/**
 * Create or return the blur overlay for a video.
 *
 * @param video - HTMLVideoElement to cover.
 * @returns Overlay div attached to document.body.
 */
function ensureBlurOverlay(video: HTMLVideoElement): HTMLDivElement {
  let overlay = blurOverlays.get(video);
  if (overlay) {
    return overlay;
  }

  overlay = document.createElement("div");
  overlay.className = BLUR_OVERLAY_CLASS;
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483646";
  overlay.style.backgroundColor = BLUR_OVERLAY_TINT;
  overlay.style.backdropFilter = BLUR_BACKDROP;
  overlay.style.setProperty("-webkit-backdrop-filter", BLUR_BACKDROP);
  overlay.style.display = "none";

  const playerHost = shouldUseBlurOverlay() ? findYouTubePlayerHost(video) : null;
  if (playerHost) {
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    if (getComputedStyle(playerHost).position === "static") {
      playerHost.style.position = "relative";
    }
    playerHost.appendChild(overlay);
  } else {
    overlay.style.position = "fixed";
    document.body.appendChild(overlay);
  }

  blurOverlays.set(video, overlay);
  return overlay;
}

/**
 * Apply blur to YouTube's player container (filter on <video> alone is often ignored).
 *
 * @param video - Target HTMLVideoElement.
 */
function applyBlurToPlayerHost(video: HTMLVideoElement): void {
  const host = findYouTubePlayerHost(video);
  if (!host) {
    return;
  }

  if (!blurredPlayerHosts.has(video)) {
    blurredPlayerHosts.set(video, {
      originalFilter: host.style.filter,
      originalTransition: host.style.transition,
    });
  }

  host.style.transition = BLUR_TRANSITION;
  host.style.setProperty("filter", BLUR_FILTER, "important");
}

/**
 * Restore YouTube player container styles after CLEAR.
 *
 * @param video - Target HTMLVideoElement.
 */
function clearBlurFromPlayerHost(video: HTMLVideoElement): void {
  const saved = blurredPlayerHosts.get(video);
  const host = findYouTubePlayerHost(video);

  if (host) {
    host.style.removeProperty("filter");
  }

  if (saved && host) {
    host.style.transition = saved.originalTransition;
    if (saved.originalFilter) {
      host.style.filter = saved.originalFilter;
    }
  }

  blurredPlayerHosts.delete(video);
}

/**
 * Keep overlay aligned while the player moves (scroll, theater mode, resize).
 */
function startOverlaySyncLoop(): void {
  if (overlaySyncHandle !== null) {
    return;
  }

  const tick = (): void => {
    for (const video of blurredVideoSet) {
      const overlay = blurOverlays.get(video);
      if (overlay && video.isConnected) {
        syncOverlayToVideo(video, overlay);
      }
    }

    if (blurredVideoSet.size === 0) {
      overlaySyncHandle = null;
      return;
    }

    overlaySyncHandle = requestAnimationFrame(tick);
  };

  overlaySyncHandle = requestAnimationFrame(tick);
}

/**
 * Stop repositioning blur overlays.
 */
function stopOverlaySyncLoop(): void {
  if (overlaySyncHandle !== null) {
    cancelAnimationFrame(overlaySyncHandle);
    overlaySyncHandle = null;
  }
}

/**
 * Show the backdrop blur overlay on top of the video bounds.
 *
 * @param video - HTMLVideoElement to cover.
 */
function showBlurOverlay(video: HTMLVideoElement): void {
  const overlay = ensureBlurOverlay(video);
  syncOverlayToVideo(video, overlay);
  startOverlaySyncLoop();

  // #region agent log
  debugBlurLog(
    "blur overlay shown",
    {
      rectW: video.getBoundingClientRect().width,
      rectH: video.getBoundingClientRect().height,
    },
    "H3"
  );
  // #endregion
}

/**
 * Hide and detach the blur overlay for a video.
 *
 * @param video - HTMLVideoElement to uncover.
 */
function hideBlurOverlay(video: HTMLVideoElement): void {
  const overlay = blurOverlays.get(video);
  if (!overlay) {
    return;
  }

  overlay.style.display = "none";
  overlay.remove();
  blurOverlays.delete(video);

  if (blurredVideoSet.size === 0) {
    stopOverlaySyncLoop();
  }
}

/**
 * Apply blur(24px) to the full <video> element (and overlay on YouTube).
 *
 * @param videoId - Target video id from the service worker.
 */
export function applyBlur(videoId: number, trace?: Partial<BlurCommandMessage>): void {
  const video = resolveBlurTarget(videoId);
  const blurAppliedAt = performance.now();

  if (trace?.capturedAt !== undefined) {
    const captureToBlurMs = Math.round(blurAppliedAt - trace.capturedAt);
    const backendToBlurMs =
      trace.backendDoneAt !== undefined
        ? Math.round(blurAppliedAt - trace.backendDoneAt)
        : undefined;

    console.info(
      "[SafeView][Latency] blur applied video=%s capture→blur=%sms backend→blur=%sms",
      videoId,
      captureToBlurMs,
      backendToBlurMs ?? "?"
    );
  }

  // #region agent log
  debugBlurLog(
    video ? "applyBlur" : "applyBlur skipped",
    {
      commandVideoId: videoId,
      useOverlay: shouldUseBlurOverlay(),
      targetArea: video
        ? video.getBoundingClientRect().width * video.getBoundingClientRect().height
        : 0,
      inlineFilter: video?.style.filter ?? "",
      computedFilter: video ? getComputedStyle(video).filter : "",
      playerHostId: video ? findYouTubePlayerHost(video)?.id ?? null : null,
    },
    "H2"
  );
  // #endregion

  if (!video) {
    return;
  }

  consecutiveClearCount = 0;
  blurHoldUntil = Date.now() + MIN_BLUR_HOLD_MS;

  if (!blurredStyles.has(video)) {
    blurredStyles.set(video, {
      originalFilter: video.style.filter,
      originalTransition: video.style.transition,
    });
    blurredVideoSet.add(video);
  }

  video.style.transition = BLUR_TRANSITION;
  video.style.setProperty("filter", BLUR_FILTER, "important");

  if (shouldUseBlurOverlay()) {
    applyBlurToPlayerHost(video);
    showBlurOverlay(video);
  }
}

/**
 * Remove blur and restore original inline filter/transition on a video.
 *
 * @param videoId - Target video id from the service worker.
 */
export function clearBlur(videoId: number): void {
  pruneDisconnectedBlurredVideos();

  consecutiveClearCount += 1;

  if (consecutiveClearCount < CLEAR_STREAK_REQUIRED) {
    // #region agent log
    debugBlurLog(
      "clearBlur deferred — streak",
      { commandVideoId: videoId, consecutiveClearCount },
      "H1"
    );
    // #endregion
    return;
  }

  if (isBlurHoldActive()) {
    // #region agent log
    debugBlurLog(
      "clearBlur deferred — hold",
      { commandVideoId: videoId, blurHoldUntil },
      "H1"
    );
    // #endregion
    return;
  }

  const video = resolveBlurTarget(videoId);
  if (!video) {
    return;
  }

  // #region agent log
  debugBlurLog("clearBlur executed", { commandVideoId: videoId }, "H1");
  // #endregion

  clearBlurForElement(video);
}

/**
 * Restore original styles for one video element.
 *
 * @param video - HTMLVideoElement to unblur.
 */
function clearBlurForElement(video: HTMLVideoElement): void {
  const saved = blurredStyles.get(video);

  video.style.removeProperty("filter");
  clearBlurFromPlayerHost(video);
  hideBlurOverlay(video);

  if (saved) {
    video.style.transition = saved.originalTransition;
    if (saved.originalFilter) {
      video.style.filter = saved.originalFilter;
    }
    blurredStyles.delete(video);
  } else {
    video.style.transition = "";
  }

  blurredVideoSet.delete(video);
  consecutiveClearCount = 0;

  if (blurredVideoSet.size === 0) {
    stopOverlaySyncLoop();
  }
}

/**
 * Drop tracking for videos removed from the DOM without a CLEAR message.
 */
function pruneDisconnectedBlurredVideos(): void {
  for (const video of blurredVideoSet) {
    if (!video.isConnected) {
      clearBlurForElement(video);
    }
  }
}

/**
 * Handle MutationObserver removals so blur state does not leak.
 *
 * @param mutations - DOM mutation records.
 */
function handleBlurRemovalMutations(mutations: MutationRecord[]): void {
  let shouldPrune = false;

  for (const mutation of mutations) {
    mutation.removedNodes.forEach((node) => {
      if (node instanceof HTMLVideoElement && blurredVideoSet.has(node)) {
        shouldPrune = true;
      } else if (node instanceof Element) {
        node.querySelectorAll("video").forEach((video) => {
          if (blurredVideoSet.has(video)) {
            shouldPrune = true;
          }
        });
      }
    });
  }

  if (shouldPrune) {
    pruneDisconnectedBlurredVideos();
  }
}

/**
 * Route BLUR / CLEAR messages from the service worker.
 *
 * @param message - Runtime message payload.
 * @returns True when the message was handled.
 */
function handleRuntimeMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }

  const command = message as Partial<BlurCommandMessage>;
  const videoId = command.videoId;

  if (typeof videoId !== "number") {
    return false;
  }

  if (command.action === MESSAGE_ACTION_BLUR) {
    applyBlur(videoId, command);
    return true;
  }

  if (command.action === MESSAGE_ACTION_CLEAR) {
    clearBlur(videoId);
    return true;
  }

  return false;
}

/**
 * Observe DOM removals to clean up blur state for detached videos.
 */
function setupRemovalObserver(): void {
  removalObserver = new MutationObserver(handleBlurRemovalMutations);
  removalObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/**
 * Listen for BLUR / CLEAR commands and watch for videos leaving the DOM.
 */
export function initBlurManager(): void {
  if (isBlurManagerInitialized) {
    return;
  }

  isBlurManagerInitialized = true;

  chrome.runtime.onMessage.addListener((message) => {
    try {
      handleRuntimeMessage(message);
    } catch (error) {
      console.error("[SafeView] Blur manager message handling failed:", error);
    }
  });

  setupRemovalObserver();
  console.info("[SafeView] Blur manager initialized.");
}

/**
 * Tear down blur manager observers and clear all active blurs.
 */
export function teardownBlurManager(): void {
  if (!isBlurManagerInitialized) {
    return;
  }

  isBlurManagerInitialized = false;

  if (removalObserver) {
    removalObserver.disconnect();
    removalObserver = null;
  }

  for (const video of [...blurredVideoSet]) {
    clearBlurForElement(video);
  }

  blurredVideoSet.clear();
  stopOverlaySyncLoop();
}

/**
 * Returns whether a video currently has SafeView blur applied.
 *
 * @param video - HTMLVideoElement to check.
 * @returns True if blur filter is active via this manager.
 */
export function isVideoBlurred(video: HTMLVideoElement): boolean {
  return blurredVideoSet.has(video);
}
