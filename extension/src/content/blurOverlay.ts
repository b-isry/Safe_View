// SafeView — blurOverlay.ts
// Purpose: Full-frame and region blur overlays for video elements.

import type { DetectionBox } from "../shared/apiTypes";

const BLUR_FILTER_VALUE = "blur(24px)";
const DATA_BLURRED = "safeViewBlurred";
const DATA_ORIGINAL_FILTER = "safeViewOriginalFilter";
const DATA_ORIGINAL_TRANSITION = "safeViewOriginalTransition";

const REGION_OVERLAY_CLASS = "sv-blur-overlay";
const REGION_PATCH_CLASS = "sv-region-blur";
const IMAGE_BLUR_OVERLAY_CLASS = "sv-image-blur-overlay";
const IMAGE_SCORE_LABEL_CLASS = "sv-image-score-label";

let imageOverlayStylesInjected = false;

function ensureImageOverlayStyles(): void {
  if (imageOverlayStylesInjected) {
    return;
  }
  imageOverlayStylesInjected = true;

  const style = document.createElement("style");
  style.setAttribute("data-safeview", "image-blur");
  style.textContent = `
    .${IMAGE_BLUR_OVERLAY_CLASS} {
      position: fixed !important;
      pointer-events: none !important;
      z-index: 2147483646 !important;
      box-sizing: border-box !important;
      backdrop-filter: blur(24px) !important;
      -webkit-backdrop-filter: blur(24px) !important;
      background: rgba(13, 27, 42, 0.55) !important;
      border-radius: 2px;
    }
    .${IMAGE_SCORE_LABEL_CLASS} {
      position: fixed !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      box-sizing: border-box !important;
      font: 600 10px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif !important;
      letter-spacing: 0.02em;
      padding: 2px 5px !important;
      border-radius: 3px !important;
      color: #fff !important;
      white-space: nowrap !important;
      text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    }
    .${IMAGE_SCORE_LABEL_CLASS}--blur {
      background: rgba(160, 32, 48, 0.92) !important;
    }
    .${IMAGE_SCORE_LABEL_CLASS}--clear {
      background: rgba(32, 96, 56, 0.88) !important;
    }
  `;
  document.documentElement.appendChild(style);
}

interface OverlayLayoutState {
  overlayRoot: HTMLDivElement | null;
  layoutListeners: Array<() => void>;
}

interface VideoBlurState extends OverlayLayoutState {}

interface ImageBlurState extends OverlayLayoutState {
  scoreLabel: HTMLDivElement | null;
}

const regionStateByVideo = new WeakMap<HTMLVideoElement, VideoBlurState>();
const imageBlurStateByImg = new WeakMap<HTMLImageElement, ImageBlurState>();

function getRegionState(video: HTMLVideoElement): VideoBlurState {
  let state = regionStateByVideo.get(video);
  if (!state) {
    state = { overlayRoot: null, layoutListeners: [] };
    regionStateByVideo.set(video, state);
  }
  return state;
}

function removeLayoutListeners(state: VideoBlurState | ImageBlurState): void {
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

function getImageBlurState(img: HTMLImageElement): ImageBlurState {
  let state = imageBlurStateByImg.get(img);
  if (!state) {
    state = { overlayRoot: null, scoreLabel: null, layoutListeners: [] };
    imageBlurStateByImg.set(img, state);
  }
  return state;
}

function syncImageScoreLabel(img: HTMLImageElement, label: HTMLDivElement): void {
  const rect = img.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    label.style.display = "none";
    return;
  }

  label.style.display = "block";
  label.style.left = `${Math.round(rect.right - 4)}px`;
  label.style.top = `${Math.round(rect.top + 4)}px`;
  label.style.transform = "translate(-100%, 0)";
}

function ensureImageLayoutListeners(img: HTMLImageElement, state: ImageBlurState): void {
  if (state.layoutListeners.length > 0) {
    return;
  }

  const onLayout = (): void => {
    if (!img.isConnected) {
      return;
    }
    if (state.overlayRoot && img.dataset[DATA_BLURRED] === "true") {
      syncImageBlurOverlay(img, state.overlayRoot);
    }
    if (state.scoreLabel) {
      syncImageScoreLabel(img, state.scoreLabel);
    }
  };

  window.addEventListener("scroll", onLayout, true);
  window.addEventListener("resize", onLayout);
  window.addEventListener("fullscreenchange", onLayout);

  state.layoutListeners.push(() => window.removeEventListener("scroll", onLayout, true));
  state.layoutListeners.push(() => window.removeEventListener("resize", onLayout));
  state.layoutListeners.push(() => document.removeEventListener("fullscreenchange", onLayout));
}

function syncImageBlurOverlay(img: HTMLImageElement, overlay: HTMLDivElement): void {
  const rect = img.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    overlay.style.display = "none";
    return;
  }

  overlay.style.display = "block";
  overlay.style.left = `${Math.round(rect.left)}px`;
  overlay.style.top = `${Math.round(rect.top)}px`;
  overlay.style.width = `${Math.round(rect.width)}px`;
  overlay.style.height = `${Math.round(rect.height)}px`;
}

function ensureImageBlurOverlay(img: HTMLImageElement): HTMLDivElement {
  const state = getImageBlurState(img);
  if (state.overlayRoot) {
    syncImageBlurOverlay(img, state.overlayRoot);
    return state.overlayRoot;
  }

  const overlay = document.createElement("div");
  overlay.className = IMAGE_BLUR_OVERLAY_CLASS;
  overlay.setAttribute("aria-hidden", "true");
  document.body.appendChild(overlay);
  state.overlayRoot = overlay;
  syncImageBlurOverlay(img, overlay);

  ensureImageLayoutListeners(img, state);

  return overlay;
}

/**
 * Small fixed badge on an <img> showing the last nudity score (e.g. "0.79").
 */
export function updateImageScoreLabel(
  img: HTMLImageElement,
  score: number,
  blurred: boolean
): void {
  if (!img.isConnected) {
    return;
  }

  ensureImageOverlayStyles();
  const state = getImageBlurState(img);
  ensureImageLayoutListeners(img, state);

  if (!state.scoreLabel) {
    const label = document.createElement("div");
    label.className = IMAGE_SCORE_LABEL_CLASS;
    label.setAttribute("aria-hidden", "true");
    label.title = "SafeView nudity score";
    document.body.appendChild(label);
    state.scoreLabel = label;
  }

  const label = state.scoreLabel;
  const safeScore = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  label.textContent = safeScore.toFixed(2);
  label.classList.toggle(`${IMAGE_SCORE_LABEL_CLASS}--blur`, blurred);
  label.classList.toggle(`${IMAGE_SCORE_LABEL_CLASS}--clear`, !blurred);
  syncImageScoreLabel(img, label);
}

/** Remove the score badge from an <img>. */
export function clearImageScoreLabel(img: HTMLImageElement): void {
  const state = imageBlurStateByImg.get(img);
  if (!state?.scoreLabel) {
    return;
  }

  state.scoreLabel.remove();
  state.scoreLabel = null;

  if (!state.overlayRoot) {
    removeLayoutListeners(state);
    imageBlurStateByImg.delete(img);
  }
}

/**
 * Full-frame blur for a static <img> using a fixed frosted overlay (visible on CDN thumbnails).
 * Also sets filter when the site does not override it.
 */
export function applyImageBlur(img: HTMLImageElement): void {
  if (!img.isConnected) {
    return;
  }

  ensureImageOverlayStyles();
  img.dataset[DATA_BLURRED] = "true";

  if (img.dataset[DATA_ORIGINAL_FILTER] === undefined) {
    img.dataset[DATA_ORIGINAL_FILTER] = img.style.filter || "";
  }
  img.style.setProperty("filter", BLUR_FILTER_VALUE, "important");

  ensureImageBlurOverlay(img);
}

/** Remove full-frame blur from a static <img>. */
export function clearImageBlur(img: HTMLImageElement): void {
  if (img.dataset[DATA_BLURRED] !== "true") {
    return;
  }

  const state = getImageBlurState(img);
  if (state.overlayRoot) {
    state.overlayRoot.remove();
    state.overlayRoot = null;
  }

  if (!state.scoreLabel) {
    removeLayoutListeners(state);
    imageBlurStateByImg.delete(img);
  }

  img.style.filter = img.dataset[DATA_ORIGINAL_FILTER] ?? "";
  delete img.dataset[DATA_BLURRED];
  delete img.dataset[DATA_ORIGINAL_FILTER];
}

/** Full-frame blur for an element with a CSS background image. */
export function applyElementImageBlur(element: HTMLElement): void {
  if (element.dataset[DATA_BLURRED] === "true") {
    return;
  }

  if (element.dataset[DATA_ORIGINAL_FILTER] === undefined) {
    element.dataset[DATA_ORIGINAL_FILTER] = element.style.filter || "";
  }

  element.dataset[DATA_BLURRED] = "true";
  element.style.filter = BLUR_FILTER_VALUE;
}

/** Clear background-image element blur. */
export function clearElementImageBlur(element: HTMLElement): void {
  if (element.dataset[DATA_BLURRED] !== "true") {
    return;
  }

  element.style.filter = element.dataset[DATA_ORIGINAL_FILTER] ?? "";
  delete element.dataset[DATA_BLURRED];
  delete element.dataset[DATA_ORIGINAL_FILTER];
}

export const BLUR_FILTER = BLUR_FILTER_VALUE;
