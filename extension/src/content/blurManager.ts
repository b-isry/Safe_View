// SafeView — blurManager.ts
// Purpose: Apply and remove full-video or region blur on BLUR / CLEAR messages.

import type { DetectionBox } from "../shared/apiTypes";
import {
  applyFullVideoBlur,
  applyImageBlur,
  applyRegionBlur,
  clearAllBlur,
  clearFullVideoBlur,
  clearImageBlur,
  clearRegionBlur,
  BLUR_FILTER,
} from "./blurOverlay";
import {
  clearAllFullVideoBlurs,
  getBlurredVideoSet,
} from "./fullVideoBlur";
import {
  getImageById,
  isStaticImageId,
} from "./imageMonitor";
import {
  findPrimaryVisibleVideo,
  getVideoById,
} from "./videoMonitor";

export { BLUR_RADIUS_PX, BLUR_BACKDROP, BLUR_OVERLAY_CLASS, BLUR_OVERLAY_TINT } from "./fullVideoBlur";
export { BLUR_FILTER };

export const BLUR_CLEAR_TRANSITION_SECONDS = 0;
export const BLUR_CLEAR_TRANSITION = `filter ${BLUR_CLEAR_TRANSITION_SECONDS}s ease`;
export const BLUR_TRANSITION_SECONDS = BLUR_CLEAR_TRANSITION_SECONDS;
export const BLUR_TRANSITION = BLUR_CLEAR_TRANSITION;
export const MIN_BLUR_HOLD_MS = 0;
export const CLEAR_STREAK_REQUIRED = 1;
export const BLUR_OVERLAY_Z_INDEX = 1;

export const MESSAGE_ACTION_BLUR = "BLUR";
export const MESSAGE_ACTION_CLEAR = "CLEAR";

export interface BlurCommandMessage {
  action: typeof MESSAGE_ACTION_BLUR | typeof MESSAGE_ACTION_CLEAR;
  videoId: number;
  capturedAt?: number;
  sentAt?: number;
  swReceivedAt?: number;
  backendDoneAt?: number;
  commandSeq?: number;
  preemptive?: boolean;
  blurMode?: "full" | "regions";
  detections?: DetectionBox[];
}

const latestBlurCommandSeq = new Map<number, number>();
const regionBlurVideos = new Set<HTMLVideoElement>();

let removalObserver: MutationObserver | null = null;
let isBlurManagerInitialized = false;
let overlayStylesInjected = false;

function injectOverlayStyles(): void {
  if (overlayStylesInjected) {
    return;
  }
  overlayStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .sv-blur-overlay {
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      overflow: hidden;
    }
    .sv-region-blur {
      position: absolute;
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      background: rgba(255, 255, 255, 0.01);
      pointer-events: none;
    }
    .sv-image-blur-overlay {
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      box-sizing: border-box;
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      background: rgba(13, 27, 42, 0.45);
      border-radius: 2px;
    }
  `;
  document.documentElement.appendChild(style);
}

function resolveBlurTarget(
  videoId: number
): HTMLVideoElement | HTMLImageElement | undefined {
  if (isStaticImageId(videoId)) {
    const img = getImageById(videoId);
    if (!img) {
      return undefined;
    }
    if (!img.isConnected) {
      clearImageBlur(img);
      return undefined;
    }
    return img;
  }

  const byId = getVideoById(videoId);
  if (!byId) {
    return undefined;
  }

  if (!byId.isConnected) {
    clearAllBlur(byId);
    regionBlurVideos.delete(byId);
    return undefined;
  }

  const primary = findPrimaryVisibleVideo();
  return primary ?? byId;
}

export function applyBlur(videoId: number, command: Partial<BlurCommandMessage> = {}): void {
  injectOverlayStyles();
  const target = resolveBlurTarget(videoId);
  if (!target) {
    if (videoId >= 1_000_000) {
      console.warn(
        "[SafeView][Image] BLUR command ignored — image id=%s not in tab registry (reload page?)",
        videoId
      );
    }
    return;
  }

  if (target instanceof HTMLImageElement) {
    applyImageBlur(target);
    console.info(
      "[SafeView][Image] BLUR command applied to <img> id=%s (%sx%s)",
      videoId,
      Math.round(target.getBoundingClientRect().width),
      Math.round(target.getBoundingClientRect().height)
    );
    return;
  }

  const mode = command.blurMode ?? "full";
  const detections = command.detections ?? [];

  if (mode === "regions" && detections.length > 0) {
    clearFullVideoBlur(target);
    regionBlurVideos.add(target);
    applyRegionBlur(target, detections);
    return;
  }

  regionBlurVideos.delete(target);
  clearRegionBlur(target);
  applyFullVideoBlur(target);
}

export function clearBlur(videoId: number): void {
  if (isStaticImageId(videoId)) {
    const img = getImageById(videoId);
    if (img) {
      clearImageBlur(img);
    }
    return;
  }

  pruneDisconnectedBlurredVideos();

  const video = resolveBlurTarget(videoId);
  if (!video) {
    return;
  }

  regionBlurVideos.delete(video);
  clearAllBlur(video);
}

function pruneDisconnectedBlurredVideos(): void {
  for (const video of getBlurredVideoSet()) {
    if (!video.isConnected) {
      clearAllBlur(video);
      regionBlurVideos.delete(video);
    }
  }
  for (const video of [...regionBlurVideos]) {
    if (!video.isConnected) {
      clearAllBlur(video);
      regionBlurVideos.delete(video);
    }
  }
}

function handleBlurRemovalMutations(mutations: MutationRecord[]): void {
  let shouldPrune = false;

  for (const mutation of mutations) {
    mutation.removedNodes.forEach((node) => {
      if (node instanceof HTMLVideoElement) {
        shouldPrune = true;
      } else if (node instanceof Element) {
        if (node.querySelector("video")) {
          shouldPrune = true;
        }
      }
    });
  }

  if (shouldPrune) {
    pruneDisconnectedBlurredVideos();
  }
}

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

function setupRemovalObserver(): void {
  removalObserver = new MutationObserver(handleBlurRemovalMutations);
  removalObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

export function initBlurManager(): void {
  if (isBlurManagerInitialized) {
    return;
  }

  isBlurManagerInitialized = true;
  injectOverlayStyles();

  chrome.runtime.onMessage.addListener((message) => {
    try {
      handleRuntimeMessage(message);
    } catch (error) {
      console.error("[SafeView] Blur manager message handling failed:", error);
    }
  });

  setupRemovalObserver();
  console.info("[SafeView] Blur manager initialized (full + region).");
}

export function resetBlurStateForNavigation(_reason: string): void {
  for (const video of [...getBlurredVideoSet()]) {
    clearRegionBlur(video);
    clearImmediateLocalBlur(video);
  }
  for (const video of [...regionBlurVideos]) {
    clearRegionBlur(video);
    clearImmediateLocalBlur(video);
  }

  regionBlurVideos.clear();
  latestBlurCommandSeq.clear();
  clearAllFullVideoBlurs();
}

export function teardownBlurManager(): void {
  if (!isBlurManagerInitialized) {
    return;
  }

  isBlurManagerInitialized = false;

  if (removalObserver) {
    removalObserver.disconnect();
    removalObserver = null;
  }

  resetBlurStateForNavigation("teardown");
}

export function isVideoBlurred(video: HTMLVideoElement): boolean {
  if (!video.isConnected) {
    return false;
  }

  const filter = video.style.filter || "";
  return (
    video.dataset.safeViewBlurred === "true" ||
    filter.includes("blur") ||
    regionBlurVideos.has(video)
  );
}

/** Preemptive full-video blur (videoMonitor). */
export function applyImmediateLocalBlur(video: HTMLVideoElement): void {
  applyFullVideoBlur(video);
}

export function clearImmediateLocalBlur(video: HTMLVideoElement): void {
  clearAllBlur(video);
}

export function clearAllBlurs(): void {
  resetBlurStateForNavigation("clear_all");
}
