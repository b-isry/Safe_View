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

/** Transition duration when blur is removed (seconds). */
export const BLUR_CLEAR_TRANSITION_SECONDS = 0.15;

/** CSS transition for unblur only — BLUR applies instantly. */
export const BLUR_CLEAR_TRANSITION = `filter ${BLUR_CLEAR_TRANSITION_SECONDS}s ease`;

/** @deprecated Use BLUR_CLEAR_TRANSITION — kept for tests. */
export const BLUR_TRANSITION_SECONDS = BLUR_CLEAR_TRANSITION_SECONDS;

/** @deprecated Use BLUR_CLEAR_TRANSITION — kept for tests. */
export const BLUR_TRANSITION = BLUR_CLEAR_TRANSITION;

/** Minimum time blur stays on after BLUR (matches BR-05 mute duration). */
export const MIN_BLUR_HOLD_MS = 1500;

/** Consecutive CLEAR messages required before unblur (reduces flicker). */
export const CLEAR_STREAK_REQUIRED = 3;

/** DOM class for the full-video blur overlay layer. */
export const BLUR_OVERLAY_CLASS = "safeview-blur-overlay";

/** Frosted overlay tint when backdrop-filter alone is insufficient (YouTube). */
export const BLUR_OVERLAY_TINT = "rgba(13, 27, 42, 0.72)";

/**
 * Overlay stacking — above the video pixels, below site player chrome (YouTube controls ~61).
 */
export const BLUR_OVERLAY_Z_INDEX = 1;

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
  commandSeq?: number;
  preemptive?: boolean;
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
const blurredVideoSet = new Set<HTMLVideoElement>();

let removalObserver: MutationObserver | null = null;
let isBlurManagerInitialized = false;
let overlaySyncHandle: number | null = null;

/** Latest accepted commandSeq per videoId (stale BLUR/CLEAR ignored). */
const latestBlurCommandSeq = new Map<number, number>();

/**
 * True on YouTube watch pages where <video> CSS filter is often not visible.
 */
function shouldUseBlurOverlay(): boolean {
  return /(^|\.)youtube\.com$/i.test(window.location.hostname);
}

/**
 * Parent for the overlay — direct parent of <video> (excludes player chrome siblings).
 *
 * @param video - Target HTMLVideoElement.
 * @returns Positioning parent, or null.
 */
function findOverlayParent(video: HTMLVideoElement): HTMLElement | null {
  const parent = video.parentElement;
  if (parent instanceof HTMLElement && parent !== document.body) {
    return parent;
  }

  return null;
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
 * Position the overlay to match only the <video> element bounds (not player chrome).
 *
 * @param video - Target HTMLVideoElement.
 * @param overlay - Overlay div to align.
 */
function syncOverlayToVideo(video: HTMLVideoElement, overlay: HTMLDivElement): void {
  const parent = overlay.parentElement;
  if (!parent) {
    return;
  }

  const videoRect = video.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();

  const width = Math.round(videoRect.width);
  const height = Math.round(videoRect.height);

  if (width < 1 || height < 1) {
    overlay.style.display = "none";
    return;
  }

  const x = Math.round(videoRect.left - parentRect.left);
  const y = Math.round(videoRect.top - parentRect.top);

  overlay.style.display = "block";
  overlay.style.left = `${x}px`;
  overlay.style.top = `${y}px`;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;

  const posKey = `${x},${y},${width},${height}`;
  if (overlay.dataset.safeviewPos !== posKey) {
    overlay.dataset.safeviewPos = posKey;
    console.info(
      "[SafeView][OVERLAY] positioned %s %s %s %s z-index=%s",
      x,
      y,
      width,
      height,
      overlay.style.zIndex
    );
  }
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
  overlay.style.position = "absolute";
  overlay.style.zIndex = String(BLUR_OVERLAY_Z_INDEX);
  overlay.style.backgroundColor = BLUR_OVERLAY_TINT;
  overlay.style.backdropFilter = BLUR_BACKDROP;
  overlay.style.setProperty("-webkit-backdrop-filter", BLUR_BACKDROP);
  overlay.style.display = "none";

  if (shouldUseBlurOverlay()) {
    const parent = findOverlayParent(video);
    if (parent) {
      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }
      parent.appendChild(overlay);
    }
  }

  blurOverlays.set(video, overlay);
  return overlay;
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
  if (!shouldUseBlurOverlay()) {
    return;
  }

  const overlay = ensureBlurOverlay(video);
  syncOverlayToVideo(video, overlay);
  startOverlaySyncLoop();
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
      "[SafeView][Latency] blur apply video=%s capture→blur=%sms backend→blur=%sms preemptive=%s",
      videoId,
      captureToBlurMs,
      backendToBlurMs ?? "?",
      trace?.preemptive === true ? "yes" : "no"
    );
  }

  if (!video) {
    return;
  }

  if (!blurredStyles.has(video)) {
    blurredStyles.set(video, {
      originalFilter: video.style.filter,
      originalTransition: video.style.transition,
    });
    blurredVideoSet.add(video);
  }

  video.style.transition = "none";
  video.style.setProperty("filter", BLUR_FILTER, "important");

  showBlurOverlay(video);
}

/**
 * Remove blur and restore original inline filter/transition on a video.
 *
 * @param videoId - Target video id from the service worker.
 */
export function clearBlur(videoId: number): void {
  pruneDisconnectedBlurredVideos();

  const video = resolveBlurTarget(videoId);
  if (!video) {
    return;
  }

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
  hideBlurOverlay(video);

  if (saved) {
    video.style.transition = BLUR_CLEAR_TRANSITION;
    if (saved.originalFilter) {
      video.style.filter = saved.originalFilter;
    }
    if (saved.originalTransition) {
      window.setTimeout(() => {
        video.style.transition = saved.originalTransition;
      }, BLUR_CLEAR_TRANSITION_SECONDS * 1000);
    }
    blurredStyles.delete(video);
  } else {
    video.style.transition = BLUR_CLEAR_TRANSITION;
  }

  blurredVideoSet.delete(video);

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
/**
 * Ignore BLUR/CLEAR when an older commandSeq arrives after a newer one.
 *
 * @param videoId - Target video id.
 * @param commandSeq - Sequence from the service worker.
 * @returns True when the command should be applied.
 */
function acceptBlurCommand(videoId: number, commandSeq: number | undefined): boolean {
  if (commandSeq === undefined) {
    return true;
  }

  const last = latestBlurCommandSeq.get(videoId) ?? 0;
  if (commandSeq < last) {
    return false;
  }

  latestBlurCommandSeq.set(videoId, commandSeq);
  return true;
}

function handleRuntimeMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }

  const command = message as Partial<BlurCommandMessage>;
  const videoId = command.videoId;

  if (typeof videoId !== "number") {
    return false;
  }

  if (!acceptBlurCommand(videoId, command.commandSeq)) {
    return true;
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
 * Reset all blur state when the user navigates to a new video (SPA / URL change).
 *
 * @param _reason - Diagnostic label (unused; kept for callers).
 */
export function resetBlurStateForNavigation(_reason: string): void {
  for (const video of [...blurredVideoSet]) {
    clearBlurForElement(video);
  }

  blurredVideoSet.clear();
  latestBlurCommandSeq.clear();
  stopOverlaySyncLoop();

  console.info("[SafeView] NEW VIDEO detected — all blur state reset");
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
  latestBlurCommandSeq.clear();
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
