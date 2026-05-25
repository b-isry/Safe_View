// SafeView — fullVideoBlur.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Synchronous full-video blur apply/clear (no service worker; no videoMonitor import).

/** Full-video blur radius (px). */
export const BLUR_RADIUS_PX = 24;

/** CSS filter value applied to the entire <video> element. */
export const BLUR_FILTER = `blur(${BLUR_RADIUS_PX}px)`;

/** Backdrop blur for sites where <video> filter is not visible (e.g. YouTube). */
export const BLUR_BACKDROP = `blur(${BLUR_RADIUS_PX}px)`;

/** DOM class for the full-video blur overlay layer. */
export const BLUR_OVERLAY_CLASS = "safeview-blur-overlay";

/** Frosted overlay tint when backdrop-filter alone is insufficient (YouTube). */
export const BLUR_OVERLAY_TINT = "rgba(13, 27, 42, 0.72)";

/** Overlay stacking — above video pixels, below YouTube controls (~61). */
export const BLUR_OVERLAY_Z_INDEX = 50;

interface BlurRestoreState {
  originalFilter: string;
  originalTransition: string;
}

const blurredStyles = new WeakMap<HTMLVideoElement, BlurRestoreState>();
const blurOverlays = new WeakMap<HTMLVideoElement, HTMLDivElement>();
const blurredVideoSet = new Set<HTMLVideoElement>();

let overlaySyncHandle: number | null = null;

/**
 * True on YouTube watch pages where <video> CSS filter is often not visible.
 */
function shouldUseBlurOverlay(): boolean {
  return /(^|\.)youtube\.com$/i.test(window.location.hostname);
}

function findOverlayParent(video: HTMLVideoElement): HTMLElement | null {
  const parent = video.parentElement;
  if (parent instanceof HTMLElement && parent !== document.body) {
    return parent;
  }
  return null;
}

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

  overlay.style.display = "block";
  overlay.style.left = `${Math.round(videoRect.left - parentRect.left)}px`;
  overlay.style.top = `${Math.round(videoRect.top - parentRect.top)}px`;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
}

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

function stopOverlaySyncLoop(): void {
  if (overlaySyncHandle !== null) {
    cancelAnimationFrame(overlaySyncHandle);
    overlaySyncHandle = null;
  }
}

function showBlurOverlay(video: HTMLVideoElement): void {
  if (!shouldUseBlurOverlay()) {
    return;
  }

  const overlay = ensureBlurOverlay(video);
  syncOverlayToVideo(video, overlay);
  startOverlaySyncLoop();
}

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
 * Apply full-video blur immediately (CSS filter + overlay when needed).
 */
export function applyImmediateLocalBlur(video: HTMLVideoElement): void {
  if (!video.isConnected) {
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
 * Remove full-video blur immediately (no hold time).
 */
export function clearImmediateLocalBlur(video: HTMLVideoElement): void {
  const saved = blurredStyles.get(video);

  video.style.removeProperty("filter");
  hideBlurOverlay(video);

  if (saved) {
    video.style.transition = "none";
    if (saved.originalFilter) {
      video.style.filter = saved.originalFilter;
    } else {
      video.style.removeProperty("filter");
    }
    if (saved.originalTransition) {
      video.style.transition = saved.originalTransition;
    }
    blurredStyles.delete(video);
  } else {
    video.style.transition = "none";
  }

  blurredVideoSet.delete(video);

  if (blurredVideoSet.size === 0) {
    stopOverlaySyncLoop();
  }
}

/**
 * True when this element currently has SafeView full-video blur applied.
 */
export function isFullVideoBlurred(video: HTMLVideoElement): boolean {
  return blurredVideoSet.has(video);
}

/**
 * Videos with active full-video blur (for blurManager routing).
 */
export function getBlurredVideoSet(): Set<HTMLVideoElement> {
  return blurredVideoSet;
}

/**
 * Remove blur from every tracked video element immediately.
 */
export function clearAllFullVideoBlurs(): void {
  for (const video of [...blurredVideoSet]) {
    clearImmediateLocalBlur(video);
  }
}
