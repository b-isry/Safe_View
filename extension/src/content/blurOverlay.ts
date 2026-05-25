// SafeView — blurOverlay.ts
// Purpose: Full-frame and region blur overlays for video elements.

import type { DetectionBox } from "../shared/apiTypes";

const BLUR_FILTER_VALUE = "blur(24px)";
const DATA_BLURRED = "safeViewBlurred";
const DATA_ORIGINAL_FILTER = "safeViewOriginalFilter";
const DATA_ORIGINAL_TRANSITION = "safeViewOriginalTransition";

const REGION_OVERLAY_CLASS = "sv-blur-overlay";
const REGION_PATCH_CLASS = "sv-region-blur";

interface VideoBlurState {
  overlayRoot: HTMLDivElement | null;
  layoutListeners: Array<() => void>;
}

const regionStateByVideo = new WeakMap<HTMLVideoElement, VideoBlurState>();

function getRegionState(video: HTMLVideoElement): VideoBlurState {
  let state = regionStateByVideo.get(video);
  if (!state) {
    state = { overlayRoot: null, layoutListeners: [] };
    regionStateByVideo.set(video, state);
  }
  return state;
}

function removeLayoutListeners(state: VideoBlurState): void {
  for (const remove of state.layoutListeners) {
    remove();
  }
  state.layoutListeners = [];
}

function syncRegionOverlay(
  video: HTMLVideoElement,
  overlay: HTMLDivElement,
  detections: DetectionBox[]
): void {
  const rect = video.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    overlay.style.display = "none";
    return;
  }

  overlay.style.display = "block";
  overlay.style.left = `${Math.round(rect.left)}px`;
  overlay.style.top = `${Math.round(rect.top)}px`;
  overlay.style.width = `${Math.round(rect.width)}px`;
  overlay.style.height = `${Math.round(rect.height)}px`;

  overlay.replaceChildren();

  for (const detection of detections) {
    const box = detection.box;
    if (!box || box.length !== 4) {
      continue;
    }

    const left = box[0] * rect.width;
    const top = box[1] * rect.height;
    const width = (box[2] - box[0]) * rect.width;
    const height = (box[3] - box[1]) * rect.height;

    if (width < 2 || height < 2) {
      continue;
    }

    const patch = document.createElement("div");
    patch.className = REGION_PATCH_CLASS;
    patch.style.left = `${Math.round(left)}px`;
    patch.style.top = `${Math.round(top)}px`;
    patch.style.width = `${Math.round(width)}px`;
    patch.style.height = `${Math.round(height)}px`;
    overlay.appendChild(patch);
  }
}

function ensureRegionOverlay(video: HTMLVideoElement): HTMLDivElement {
  const state = getRegionState(video);
  if (state.overlayRoot) {
    return state.overlayRoot;
  }

  const overlay = document.createElement("div");
  overlay.className = REGION_OVERLAY_CLASS;
  overlay.setAttribute("aria-hidden", "true");
  document.body.appendChild(overlay);
  state.overlayRoot = overlay;

  const onLayout = () => {
    if (state.overlayRoot && state.overlayRoot.style.display !== "none") {
      const detectionsAttr = overlay.dataset.detections;
      if (detectionsAttr) {
        try {
          const detections = JSON.parse(detectionsAttr) as DetectionBox[];
          syncRegionOverlay(video, overlay, detections);
        } catch {
          // ignore parse errors
        }
      }
    }
  };

  window.addEventListener("scroll", onLayout, true);
  window.addEventListener("resize", onLayout);
  document.addEventListener("fullscreenchange", onLayout);

  state.layoutListeners.push(() => window.removeEventListener("scroll", onLayout, true));
  state.layoutListeners.push(() => window.removeEventListener("resize", onLayout));
  state.layoutListeners.push(() => document.removeEventListener("fullscreenchange", onLayout));

  return overlay;
}

/** Full-frame blur ON (classifier demo switch). */
export function applyFullVideoBlur(video: HTMLVideoElement): void {
  if (video.dataset[DATA_BLURRED] === "true") {
    return;
  }

  if (video.dataset[DATA_ORIGINAL_FILTER] === undefined) {
    video.dataset[DATA_ORIGINAL_FILTER] = video.style.filter || "";
  }
  if (video.dataset[DATA_ORIGINAL_TRANSITION] === undefined) {
    video.dataset[DATA_ORIGINAL_TRANSITION] = video.style.transition || "";
  }

  video.dataset[DATA_BLURRED] = "true";
  video.style.transition = "none";
  video.style.filter = BLUR_FILTER_VALUE;
}

/** Full-frame blur OFF (classifier demo switch). */
export function clearFullVideoBlur(video: HTMLVideoElement): void {
  if (video.dataset[DATA_BLURRED] !== "true") {
    return;
  }

  const originalFilter = video.dataset[DATA_ORIGINAL_FILTER] ?? "";
  const originalTransition = video.dataset[DATA_ORIGINAL_TRANSITION] ?? "";
  video.style.filter = originalFilter;
  video.style.transition = originalTransition;

  delete video.dataset[DATA_BLURRED];
  delete video.dataset[DATA_ORIGINAL_FILTER];
  delete video.dataset[DATA_ORIGINAL_TRANSITION];
}

export function applyRegionBlur(video: HTMLVideoElement, detections: DetectionBox[]): void {
  clearFullVideoBlur(video);
  const overlay = ensureRegionOverlay(video);
  overlay.dataset.detections = JSON.stringify(detections);
  syncRegionOverlay(video, overlay, detections);
}

export function clearRegionBlur(video: HTMLVideoElement): void {
  const state = getRegionState(video);
  if (state.overlayRoot) {
    delete state.overlayRoot.dataset.detections;
    state.overlayRoot.remove();
    state.overlayRoot = null;
  }
  removeLayoutListeners(state);
}

export function clearAllBlur(video: HTMLVideoElement): void {
  clearFullVideoBlur(video);
  clearRegionBlur(video);
  regionStateByVideo.delete(video);
}

export const BLUR_FILTER = BLUR_FILTER_VALUE;
