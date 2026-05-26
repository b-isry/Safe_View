// SafeView — organicMosaic.ts
// Interview-style organic mosaic masks (soft radial edges, 8px high-density grid).

import type { DetectionBox } from "../shared/apiTypes";

const MOSAIC_OVERLAY_CLASS = "sv-organic-mosaic-root";
const MOSAIC_PATCH_CLASS = "sv-organic-mosaic-patch";
const MOSAIC_CELL_PX = 8;

interface MosaicVideoState {
  overlayRoot: HTMLDivElement | null;
  layoutListeners: Array<() => void>;
}

const mosaicStateByVideo = new WeakMap<HTMLVideoElement, MosaicVideoState>();
const mosaicVideoSet = new Set<HTMLVideoElement>();

let mosaicStylesInjected = false;

function injectMosaicStyles(): void {
  if (mosaicStylesInjected) {
    return;
  }
  mosaicStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .${MOSAIC_OVERLAY_CLASS} {
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      overflow: visible;
    }
    .${MOSAIC_PATCH_CLASS} {
      position: absolute;
      box-sizing: border-box;
      border-radius: 50%;
      -webkit-mask-image: radial-gradient(circle, black 50%, transparent 95%);
      mask-image: radial-gradient(circle, black 50%, transparent 95%);
      background-color: rgba(120, 120, 128, 0.92);
      background-image:
        linear-gradient(0deg, rgba(0, 0, 0, 0.18) 50%, transparent 50%),
        linear-gradient(90deg, rgba(0, 0, 0, 0.18) 50%, transparent 50%),
        linear-gradient(45deg, rgba(255, 255, 255, 0.08) 25%, transparent 25%),
        linear-gradient(-45deg, rgba(255, 255, 255, 0.08) 25%, transparent 25%);
      background-size: ${MOSAIC_CELL_PX}px ${MOSAIC_CELL_PX}px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      pointer-events: none;
    }
    .${MOSAIC_PATCH_CLASS}.sv-mosaic-full {
      border-radius: 12px;
      -webkit-mask-image: none;
      mask-image: none;
    }
  `;
  document.documentElement.appendChild(style);
}

function getMosaicState(video: HTMLVideoElement): MosaicVideoState {
  let state = mosaicStateByVideo.get(video);
  if (!state) {
    state = { overlayRoot: null, layoutListeners: [] };
    mosaicStateByVideo.set(video, state);
  }
  return state;
}

function removeLayoutListeners(state: MosaicVideoState): void {
  for (const remove of state.layoutListeners) {
    remove();
  }
  state.layoutListeners = [];
}

function syncMosaicOverlay(
  video: HTMLVideoElement,
  overlay: HTMLDivElement,
  detections: DetectionBox[],
  fullFrame: boolean
): void {
  const rect = video.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    overlay.style.display = "none";
    return;
  }

  overlay.style.display = "block";
  overlay.replaceChildren();

  if (fullFrame || detections.length === 0) {
    const patch = document.createElement("div");
    patch.className = `${MOSAIC_PATCH_CLASS} sv-mosaic-full`;
    patch.style.left = `${Math.round(rect.left)}px`;
    patch.style.top = `${Math.round(rect.top)}px`;
    patch.style.width = `${Math.round(rect.width)}px`;
    patch.style.height = `${Math.round(rect.height)}px`;
    overlay.appendChild(patch);
    return;
  }

  for (const detection of detections) {
    const box = detection.box;
    if (!box || box.length !== 4) {
      continue;
    }

    const left = rect.left + box[0] * rect.width;
    const top = rect.top + box[1] * rect.height;
    const width = (box[2] - box[0]) * rect.width;
    const height = (box[3] - box[1]) * rect.height;

    if (width < 4 || height < 4) {
      continue;
    }

    const patch = document.createElement("div");
    patch.className = MOSAIC_PATCH_CLASS;
    patch.style.left = `${Math.round(left)}px`;
    patch.style.top = `${Math.round(top)}px`;
    patch.style.width = `${Math.round(width)}px`;
    patch.style.height = `${Math.round(height)}px`;
    overlay.appendChild(patch);
  }
}

function ensureMosaicOverlay(video: HTMLVideoElement): HTMLDivElement {
  const state = getMosaicState(video);
  if (state.overlayRoot) {
    return state.overlayRoot;
  }

  const overlay = document.createElement("div");
  overlay.className = MOSAIC_OVERLAY_CLASS;
  overlay.setAttribute("aria-hidden", "true");
  document.body.appendChild(overlay);
  state.overlayRoot = overlay;

  const onLayout = () => {
    if (!state.overlayRoot || state.overlayRoot.style.display === "none") {
      return;
    }
    const raw = state.overlayRoot.dataset.detections;
    const fullFrame = state.overlayRoot.dataset.fullFrame === "true";
    let detections: DetectionBox[] = [];
    if (raw) {
      try {
        detections = JSON.parse(raw) as DetectionBox[];
      } catch {
        detections = [];
      }
    }
    syncMosaicOverlay(video, state.overlayRoot, detections, fullFrame);
  };

  window.addEventListener("scroll", onLayout, true);
  window.addEventListener("resize", onLayout);
  document.addEventListener("fullscreenchange", onLayout);

  state.layoutListeners.push(() => window.removeEventListener("scroll", onLayout, true));
  state.layoutListeners.push(() => window.removeEventListener("resize", onLayout));
  state.layoutListeners.push(() =>
    document.removeEventListener("fullscreenchange", onLayout)
  );

  return overlay;
}

/**
 * Apply interview-style organic mosaic (Class 2 / nudity regions or full frame).
 */
export function applyOrganicMosaic(
  video: HTMLVideoElement,
  detections: DetectionBox[] = [],
  fullFrame = false
): void {
  injectMosaicStyles();
  mosaicVideoSet.add(video);

  const overlay = ensureMosaicOverlay(video);
  overlay.dataset.detections = JSON.stringify(detections);
  overlay.dataset.fullFrame = fullFrame ? "true" : "false";
  syncMosaicOverlay(video, overlay, detections, fullFrame);
}

/**
 * Remove all mosaic masks immediately (0ms — visual_action ALLOW / CLEAR).
 */
export function clearAllMasks(): void {
  for (const video of [...mosaicVideoSet]) {
    clearMosaicForVideo(video);
  }
}

export function clearMosaicForVideo(video: HTMLVideoElement): void {
  const state = getMosaicState(video);
  if (state.overlayRoot) {
    state.overlayRoot.style.display = "none";
    state.overlayRoot.remove();
    state.overlayRoot = null;
  }
  removeLayoutListeners(state);
  mosaicStateByVideo.delete(video);
  mosaicVideoSet.delete(video);
}
