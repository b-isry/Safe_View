// SafeView — blurManager.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Apply and remove full-video blur on BLUR / CLEAR messages from the service worker.

import {
  applyImmediateLocalBlur as applyImmediateLocalBlurCore,
  BLUR_FILTER,
  BLUR_RADIUS_PX,
  BLUR_BACKDROP,
  BLUR_OVERLAY_CLASS,
  BLUR_OVERLAY_TINT,
  clearAllFullVideoBlurs,
  clearImmediateLocalBlur as clearImmediateLocalBlurCore,
  getBlurredVideoSet,
  isFullVideoBlurred,
} from "./fullVideoBlur";
import {
  findPrimaryVisibleVideo,
  getVideoById,
  MAX_APPLY_TIME_DRIFT_SEC,
} from "./videoMonitor";

export { BLUR_FILTER, BLUR_RADIUS_PX, BLUR_BACKDROP, BLUR_OVERLAY_CLASS, BLUR_OVERLAY_TINT };

/** Transition duration when blur is removed (seconds). */
export const BLUR_CLEAR_TRANSITION_SECONDS = 0;

/** CSS transition for unblur only — BLUR applies instantly. */
export const BLUR_CLEAR_TRANSITION = `filter ${BLUR_CLEAR_TRANSITION_SECONDS}s ease`;

/** @deprecated Use BLUR_CLEAR_TRANSITION — kept for tests. */
export const BLUR_TRANSITION_SECONDS = BLUR_CLEAR_TRANSITION_SECONDS;

/** @deprecated Use BLUR_CLEAR_TRANSITION — kept for tests. */
export const BLUR_TRANSITION = BLUR_CLEAR_TRANSITION;

/** No minimum hold — safe videos unblur immediately after AI CLEAR. */
export const MIN_BLUR_HOLD_MS = 0;

/** Single CLEAR is enough to unblur. */
export const CLEAR_STREAK_REQUIRED = 1;

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
  capturedVideoTime?: number;
}

let removalObserver: MutationObserver | null = null;
let isBlurManagerInitialized = false;

/** Latest accepted commandSeq per videoId (stale BLUR/CLEAR ignored). */
const latestBlurCommandSeq = new Map<number, number>();

/**
 * Apply full-video blur immediately in the content script (no service worker wait).
 */
export function applyImmediateLocalBlur(video: HTMLVideoElement): void {
  applyImmediateLocalBlurCore(video);
  console.info("[SafeView][Blur] immediate local blur applied");
}

/**
 * Remove full-video blur immediately (no hold time).
 */
export function clearImmediateLocalBlur(video: HTMLVideoElement): void {
  clearImmediateLocalBlurCore(video);
  console.info("[SafeView][Blur] immediate local blur cleared");
}

/**
 * Clear blur on every video that currently has SafeView blur applied.
 */
export function clearAllBlurs(): void {
  clearAllFullVideoBlurs();
  latestBlurCommandSeq.clear();
  console.info("[SafeView][Blur] all blurs cleared");
}

/**
 * Pick the element that should receive blur (largest visible player wins).
 */
function resolveBlurTarget(videoId: number): HTMLVideoElement | undefined {
  const byId = getVideoById(videoId);
  if (!byId) {
    return findPrimaryVisibleVideo();
  }

  if (!byId.isConnected) {
    clearImmediateLocalBlur(byId);
    return undefined;
  }

  const primary = findPrimaryVisibleVideo();
  if (primary) {
    return primary;
  }

  return byId;
}

/**
 * Apply blur(24px) to the full <video> element (and overlay on YouTube).
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

  applyImmediateLocalBlur(video);
  console.info("[SafeView][Blur] apply confirmed unsafe");
}

/**
 * Remove blur and restore original inline filter/transition on a video.
 */
export function clearBlur(videoId: number): void {
  pruneDisconnectedBlurredVideos();

  const video = resolveBlurTarget(videoId);
  if (!video) {
    return;
  }

  clearImmediateLocalBlur(video);
  console.info("[SafeView][Blur] clear confirmed safe");
}

/**
 * Drop tracking for videos removed from the DOM without a CLEAR message.
 */
function pruneDisconnectedBlurredVideos(): void {
  for (const video of getBlurredVideoSet()) {
    if (!video.isConnected) {
      clearImmediateLocalBlur(video);
    }
  }
}

/**
 * Handle MutationObserver removals so blur state does not leak.
 */
function handleBlurRemovalMutations(mutations: MutationRecord[]): void {
  let shouldPrune = false;

  for (const mutation of mutations) {
    mutation.removedNodes.forEach((node) => {
      if (node instanceof HTMLVideoElement && isFullVideoBlurred(node)) {
        shouldPrune = true;
      } else if (node instanceof Element) {
        node.querySelectorAll("video").forEach((video) => {
          if (isFullVideoBlurred(video)) {
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
 * Ignore BLUR/CLEAR when an older commandSeq arrives after a newer one.
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

function isStaleBlurCommand(video: HTMLVideoElement, command: Partial<BlurCommandMessage>): boolean {
  if (command.capturedVideoTime === undefined) {
    return false;
  }
  const drift = Math.abs(video.currentTime - command.capturedVideoTime);
  if (drift > MAX_APPLY_TIME_DRIFT_SEC) {
    console.info(
      "[SafeView][Timing] ignored delayed result drift=%s",
      drift.toFixed(3)
    );
    return true;
  }
  return false;
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

  const video = resolveBlurTarget(videoId);
  if (video && isStaleBlurCommand(video, command)) {
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
 */
export function resetBlurStateForNavigation(_reason: string): void {
  for (const video of [...getBlurredVideoSet()]) {
    clearImmediateLocalBlur(video);
  }

  latestBlurCommandSeq.clear();

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

  for (const video of [...getBlurredVideoSet()]) {
    clearImmediateLocalBlur(video);
  }

  latestBlurCommandSeq.clear();
}

/**
 * Returns whether a video currently has SafeView blur applied.
 */
export function isVideoBlurred(video: HTMLVideoElement): boolean {
  return isFullVideoBlurred(video);
}
