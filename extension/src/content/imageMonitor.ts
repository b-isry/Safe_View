// SafeView — imageMonitor.ts
// Purpose: Scan visible webpage images and blur when nudity score ≥ 0.50.

import {
  isNudityProtectionActive,
  loadSettings,
  SETTINGS_STORAGE_KEY,
  type SafeViewSettings,
} from "../background/businessRules";
import { BACKEND_TIMEOUT_MS, MAX_PENDING_ANALYSIS_MS } from "../background/latencyPolicy";
import { MESSAGE_ACTION_SETTINGS_UPDATED } from "../shared/settingsMessages";
import {
  IMAGE_BOOTSTRAP_DELAY_MS,
  IMAGE_CACHE_TTL_MS,
  IMAGE_CAPTURE_MAX_WIDTH,
  IMAGE_ICON_MAX_DIMENSION_PX,
  IMAGE_JPEG_QUALITY,
  IMAGE_MIN_DIMENSION_PX,
  IMAGE_BATCH_PER_RESCAN,
  IMAGE_MIN_RESCAN_INTERVAL_MS,
  IMAGE_NUDITY_BLUR_THRESHOLD,
  IMAGE_SHOW_SCORE_LABEL,
  IMAGE_SKIP_RESCAN_WHEN_SETTLED,
  IMAGE_RESCAN_INTERVAL_MS,
  IMAGE_SCROLL_SCAN_DEBOUNCE_MS,
  IMAGE_SCAN_DEBOUNCE_MS,
  MAX_CONCURRENT_IMAGE_SCANS,
  MAX_TRACKED_IMAGES,
} from "../shared/imageNudityPolicy";
import {
  MESSAGE_ACTION_FRAME_ANALYSIS_DONE,
  MESSAGE_ACTION_FRAME_SAMPLE,
} from "../shared/contentMessages";
import {
  applyElementImageBlur,
  applyImageBlur,
  clearElementImageBlur,
  clearImageBlur,
  clearImageScoreLabel,
  updateImageScoreLabel,
} from "./blurOverlay";

/** Content ids ≥ this value refer to HTMLImageElement (not video). */
export const IMAGE_ID_OFFSET = 1_000_000;

const JPEG_MIME_TYPE = "image/jpeg";
const SAFE_VIEW_TRACKED_DATASET = "safeViewImageTracked";
const SAFE_VIEW_BG_TRACKED = "safeViewBgTracked";
const MIN_FRAME_LUMINANCE = 12;
const MAX_BACKGROUND_TARGETS = 12;

interface ImageScanResult {
  score: number;
  shouldBlur: boolean;
  action: string;
  detected: boolean;
  scannedAt: number;
}

interface ImageScanState {
  imageId: number;
  pending: boolean;
  lastScannedAt: number;
  lastSrc: string;
  score?: number;
  blurred: boolean;
  isCapturing: boolean;
  isAnalyzing: boolean;
  analysisTimeoutId: number | null;
  lastAnalysisStartedAt: number;
  requestId: number;
  frameSeq: number;
  skipCapture: boolean;
  corsBlocked: boolean;
}

interface BackgroundScanState {
  element: HTMLElement;
  imageUrl: string;
  pending: boolean;
  lastScannedAt: number;
  blurred: boolean;
}

const trackedImages = new WeakMap<HTMLImageElement, ImageScanState>();
const imageIdToElement = new Map<number, HTMLImageElement>();
const imageIdToBackground = new Map<number, HTMLElement>();
const captureCanvasByImage = new WeakMap<HTMLImageElement, HTMLCanvasElement>();
const backgroundTargets = new WeakMap<HTMLElement, BackgroundScanState>();
const backgroundElements = new Set<HTMLElement>();
const resultCache = new Map<string, ImageScanResult>();

let nextImageId = IMAGE_ID_OFFSET;
let cachedContentSettings: SafeViewSettings | null = null;
let observer: MutationObserver | null = null;
let rescanIntervalId: number | null = null;
let bootstrapTimeoutId: number | null = null;
let debounceTimerId: number | null = null;
let scrollScanTimerId: number | null = null;
let scrollListenerRegistered = false;
let settingsListenerRegistered = false;
let inFlightScans = 0;
const scanQueue: HTMLImageElement[] = [];
let backendOfflineUntil = 0;

export function isStaticImageId(id: number): boolean {
  return id >= IMAGE_ID_OFFSET;
}

export function getImageById(imageId: number): HTMLImageElement | undefined {
  return imageIdToElement.get(imageId);
}

export function getBackgroundById(imageId: number): HTMLElement | undefined {
  return imageIdToBackground.get(imageId);
}

function isNudityActiveCached(): boolean {
  return cachedContentSettings !== null && isNudityProtectionActive(cachedContentSettings);
}

function imageCacheKey(img: HTMLImageElement): string {
  return img.currentSrc || img.src || "";
}

function getCachedResult(key: string): ImageScanResult | null {
  const entry = resultCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.scannedAt > IMAGE_CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return entry;
}

function isImageSettled(img: HTMLImageElement, state: ImageScanState): boolean {
  if (!IMAGE_SKIP_RESCAN_WHEN_SETTLED) {
    return false;
  }
  const src = imageCacheKey(img);
  if (!src || src !== state.lastSrc) {
    return false;
  }
  return getCachedResult(src) !== null;
}

function setCachedResult(key: string, result: Omit<ImageScanResult, "scannedAt">): void {
  resultCache.set(key, { ...result, scannedAt: Date.now() });
}

function layoutSize(
  el: HTMLElement
): { width: number; height: number } {
  const rect = el.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function shouldSkipTiny(width: number, height: number): boolean {
  if (width < IMAGE_MIN_DIMENSION_PX || height < IMAGE_MIN_DIMENSION_PX) {
    return true;
  }
  if (
    width < IMAGE_ICON_MAX_DIMENSION_PX &&
    height < IMAGE_ICON_MAX_DIMENSION_PX
  ) {
    return true;
  }
  return false;
}

function isImageVisible(img: HTMLImageElement): boolean {
  if (!img.isConnected) {
    return false;
  }

  const { width, height } = layoutSize(img);
  if (shouldSkipTiny(width, height)) {
    return false;
  }

  const style = window.getComputedStyle(img);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  return true;
}

function isInViewport(img: HTMLImageElement): boolean {
  const rect = img.getBoundingClientRect();
  return (
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function applyScanResultToImage(
  img: HTMLImageElement,
  state: ImageScanState,
  result: ImageScanResult
): void {
  state.score = result.score;
  state.blurred = result.shouldBlur;
  const src = imageCacheKey(img);
  if (src) {
    state.lastSrc = src;
  }

  if (IMAGE_SHOW_SCORE_LABEL) {
    updateImageScoreLabel(img, result.score, result.shouldBlur);
  }

  if (result.shouldBlur) {
    applyImageBlur(img);
    console.info(
      "[SafeView][Image] Blur applied score=%s threshold=%s (%sx%s visible)",
      result.score.toFixed(2),
      IMAGE_NUDITY_BLUR_THRESHOLD.toFixed(2),
      Math.round(img.getBoundingClientRect().width),
      Math.round(img.getBoundingClientRect().height)
    );
  } else {
    clearImageBlur(img);
    if (result.score > 0 && result.score < IMAGE_NUDITY_BLUR_THRESHOLD) {
      console.info(
        "[SafeView][Image] Clear score=%s (below threshold %s)",
        result.score.toFixed(2),
        IMAGE_NUDITY_BLUR_THRESHOLD.toFixed(2)
      );
    } else {
      console.info(
        "[SafeView][Image] Clear score=%s threshold=%s",
        result.score.toFixed(2),
        IMAGE_NUDITY_BLUR_THRESHOLD.toFixed(2)
      );
    }
  }
}

function captureDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  if (width <= IMAGE_CAPTURE_MAX_WIDTH) {
    return { width, height };
  }
  const scale = IMAGE_CAPTURE_MAX_WIDTH / width;
  return {
    width: IMAGE_CAPTURE_MAX_WIDTH,
    height: Math.max(1, Math.round(height * scale)),
  };
}

function isCrossOriginImageUrl(url: string): boolean {
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return true;
  }
}

function isFrameLikelyBlank(
  context: CanvasRenderingContext2D,
  width: number,
  height: number
): boolean {
  const sampleWidth = Math.min(32, width);
  const sampleHeight = Math.min(32, height);
  let sample: Uint8ClampedArray;
  try {
    sample = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  } catch {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < sample.length; i += 4) {
    sum += sample[i]! + sample[i + 1]! + sample[i + 2]!;
  }
  const pixelCount = sample.length / 4;
  return sum / pixelCount / 3 < MIN_FRAME_LUMINANCE;
}

async function formBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      JPEG_MIME_TYPE,
      IMAGE_JPEG_QUALITY
    );
  });
}

async function fetchImageBlob(url: string): Promise<Blob | null> {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
    return null;
  }

  try {
    const response = await fetch(url, {
      mode: "cors",
      credentials: "omit",
      cache: "force-cache",
    });
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

async function captureImageToBlob(
  img: HTMLImageElement,
  canvasWidth: number,
  canvasHeight: number
): Promise<Blob | null> {
  if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
    return null;
  }

  let canvas = captureCanvasByImage.get(img);
  if (!canvas) {
    canvas = document.createElement("canvas");
    captureCanvasByImage.set(img, canvas);
  }
  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  try {
    context.drawImage(img, 0, 0, canvasWidth, canvasHeight);
  } catch {
    const state = trackedImages.get(img);
    if (state) {
      state.corsBlocked = true;
      state.skipCapture = true;
    }
    console.info(
      "[SafeView][Image] Skipped image due to canvas/CORS restriction src=%s",
      imageCacheKey(img).slice(0, 80)
    );
    return null;
  }

  try {
    if (isFrameLikelyBlank(context, canvas.width, canvas.height)) {
      return null;
    }
    return await formBlob(canvas);
  } catch {
    return null;
  }
}

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
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsArrayBuffer(blob);
  });
}

async function sendFrameToServiceWorker(
  imageId: number,
  frame: Blob,
  capturedAt: number,
  frameSeq: number,
  captureMs: number,
  encodeMs: number,
  requestId: number,
  imageSrc: string
): Promise<void> {
  const frameBuffer = await blobToArrayBuffer(frame);
  const frameBytes = new Uint8Array(frameBuffer);

  void chrome.runtime
    .sendMessage({
      action: MESSAGE_ACTION_FRAME_SAMPLE,
      videoId: imageId,
      mediaType: "image",
      framePayload: Array.from(frameBytes),
      frameBuffer: frameBytes,
      frameMimeType: frame.type || JPEG_MIME_TYPE,
      contentBuild: chrome.runtime.getManifest().version,
      capturedAt,
      sentAt: Date.now(),
      frameSeq,
      requestId,
      sessionId: 0,
      videoSrc: imageSrc,
      videoTime: 0,
      captureMs,
      encodeMs,
    })
    .catch((error) => {
      console.warn("[SafeView][Image] Could not reach service worker:", error);
    });
}

async function sendImageUrlToServiceWorker(
  imageId: number,
  imageUrl: string,
  capturedAt: number,
  frameSeq: number,
  requestId: number
): Promise<void> {
  console.info(
    "[SafeView][Image] Sending URL to service worker (cross-origin) src=%s",
    imageUrl.slice(0, 80)
  );

  void chrome.runtime
    .sendMessage({
      action: MESSAGE_ACTION_FRAME_SAMPLE,
      videoId: imageId,
      mediaType: "image",
      imageFetchUrl: imageUrl,
      pageUrl: location.href,
      contentBuild: chrome.runtime.getManifest().version,
      capturedAt,
      sentAt: Date.now(),
      frameSeq,
      requestId,
      sessionId: 0,
      videoSrc: imageUrl,
      videoTime: 0,
      captureMs: 0,
      encodeMs: 0,
    })
    .catch((error) => {
      console.warn("[SafeView][Image] Could not reach service worker:", error);
    });
}

function beginImageAnalysis(
  state: ImageScanState,
  seq: number
): number {
  state.frameSeq = seq;
  state.requestId += 1;
  const requestId = state.requestId;
  state.isAnalyzing = true;
  state.lastAnalysisStartedAt = performance.now();
  clearAnalysisTimeout(state);
  state.analysisTimeoutId = window.setTimeout(() => {
    if (state.requestId === requestId && state.isAnalyzing) {
      state.isAnalyzing = false;
      state.pending = false;
    }
  }, BACKEND_TIMEOUT_MS);
  return requestId;
}

function clearAnalysisTimeout(state: ImageScanState): void {
  if (state.analysisTimeoutId !== null) {
    clearTimeout(state.analysisTimeoutId);
    state.analysisTimeoutId = null;
  }
}

function enqueueImageScan(img: HTMLImageElement, immediate = false): void {
  if (!isNudityActiveCached()) {
    return;
  }

  if (Date.now() < backendOfflineUntil) {
    return;
  }

  const state = trackedImages.get(img);
  if (!state || state.skipCapture || state.corsBlocked) {
    return;
  }

  if (!isImageVisible(img)) {
    return;
  }

  if (state.pending || state.isCapturing || state.isAnalyzing) {
    return;
  }

  if (isImageSettled(img, state)) {
    const src = imageCacheKey(img);
    const cached = src ? getCachedResult(src) : null;
    if (cached) {
      applyScanResultToImage(img, state, cached);
    }
    return;
  }

  const src = imageCacheKey(img);
  const cached = src ? getCachedResult(src) : null;
  if (cached) {
    applyScanResultToImage(img, state, cached);
    return;
  }

  if (!immediate) {
    const neverScanned = state.lastScannedAt === 0;
    const now = Date.now();
    if (
      !neverScanned &&
      !state.blurred &&
      now - state.lastScannedAt < IMAGE_MIN_RESCAN_INTERVAL_MS
    ) {
      return;
    }
    if (state.blurred && state.lastScannedAt > 0) {
      return;
    }
  }

  if (!scanQueue.includes(img)) {
    scanQueue.push(img);
  }
  void drainScanQueue();
}

async function drainScanQueue(): Promise<void> {
  while (inFlightScans < MAX_CONCURRENT_IMAGE_SCANS && scanQueue.length > 0) {
    const img = scanQueue.shift()!;
    inFlightScans += 1;
    try {
      await scanImage(img);
    } finally {
      inFlightScans -= 1;
      void drainScanQueue();
    }
  }
}

async function scanImage(img: HTMLImageElement): Promise<void> {
  const state = trackedImages.get(img);
  if (!state || !isNudityActiveCached()) {
    return;
  }

  if (state.skipCapture || state.corsBlocked) {
    return;
  }

  if (!isImageVisible(img)) {
    return;
  }

  const src = imageCacheKey(img);
  if (!src) {
    return;
  }

  if (src !== state.lastSrc) {
    state.lastSrc = src;
    state.blurred = false;
    clearImageBlur(img);
  }

  if (isImageSettled(img, state)) {
    const settled = getCachedResult(src);
    if (settled) {
      applyScanResultToImage(img, state, settled);
    }
    return;
  }

  const cached = getCachedResult(src);
  if (cached) {
    applyScanResultToImage(img, state, cached);
    return;
  }

  if (state.isAnalyzing) {
    const pendingMs = performance.now() - state.lastAnalysisStartedAt;
    if (pendingMs < MAX_PENDING_ANALYSIS_MS) {
      return;
    }
    state.isAnalyzing = false;
    clearAnalysisTimeout(state);
  }

  if (!img.complete || img.naturalWidth === 0) {
    return;
  }

  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  if (shouldSkipTiny(naturalW, naturalH)) {
    console.info("[SafeView][Image] Skipped tiny image");
    return;
  }

  console.info(
    "[SafeView][Image] Scanning image width=%s height=%s src=%s",
    naturalW,
    naturalH,
    src.slice(0, 80)
  );

  state.isCapturing = true;
  state.pending = true;
  const seq = state.frameSeq + 1;

  try {
    const after = trackedImages.get(img);
    if (!after) {
      return;
    }

    const requestId = beginImageAnalysis(after, seq);
    const capturedAt = Date.now();

    if (isCrossOriginImageUrl(src)) {
      await sendImageUrlToServiceWorker(
        after.imageId,
        src,
        capturedAt,
        seq,
        requestId
      );
      return;
    }

    let blob: Blob | null = await fetchImageBlob(src);
    let captureMs = 0;
    let encodeMs = 0;

    if (!blob) {
      const { width, height } = captureDimensions(naturalW, naturalH);
      const captureStarted = performance.now();
      blob = await captureImageToBlob(img, width, height);
      captureMs = Math.round(performance.now() - captureStarted);
      encodeMs = captureMs;
    }

    if (!blob) {
      await sendImageUrlToServiceWorker(
        after.imageId,
        src,
        capturedAt,
        seq,
        requestId
      );
      return;
    }

    await sendFrameToServiceWorker(
      after.imageId,
      blob,
      capturedAt,
      seq,
      captureMs,
      encodeMs,
      requestId,
      src
    );
  } catch (error) {
    console.warn("[SafeView][Image] Scan failed:", error);
    state.isAnalyzing = false;
    state.pending = false;
  } finally {
    state.isCapturing = false;
  }
}

function applyScanResultToBackground(
  element: HTMLElement,
  state: BackgroundScanState,
  result: ImageScanResult
): void {
  state.blurred = result.shouldBlur;
  if (result.shouldBlur) {
    applyElementImageBlur(element);
    console.info(
      "[SafeView][Image] Blur applied (background) score=%s threshold=%s",
      result.score.toFixed(2),
      IMAGE_NUDITY_BLUR_THRESHOLD.toFixed(2)
    );
  } else {
    clearElementImageBlur(element);
    console.info(
      "[SafeView][Image] Clear (background) score=%s threshold=%s",
      result.score.toFixed(2),
      IMAGE_NUDITY_BLUR_THRESHOLD.toFixed(2)
    );
  }
}

async function scanBackgroundElement(element: HTMLElement): Promise<void> {
  const state = backgroundTargets.get(element);
  if (!state || state.pending || !isNudityActiveCached()) {
    return;
  }

  const url = state.imageUrl;
  const cached = getCachedResult(url);
  if (cached) {
    applyScanResultToBackground(element, state, cached);
    return;
  }

  const now = Date.now();
  if (now - state.lastScannedAt < IMAGE_MIN_RESCAN_INTERVAL_MS) {
    return;
  }

  state.pending = true;
  state.lastScannedAt = now;

  const imageId = nextImageId++;
  imageIdToBackground.set(imageId, element);
  const capturedAt = Date.now();

  try {
    if (isCrossOriginImageUrl(url)) {
      await sendImageUrlToServiceWorker(imageId, url, capturedAt, 1, 1);
      return;
    }

    const blob = await fetchImageBlob(url);
    if (blob) {
      await sendFrameToServiceWorker(imageId, blob, capturedAt, 1, 0, 0, 1, url);
      return;
    }

    await sendImageUrlToServiceWorker(imageId, url, capturedAt, 1, 1);
  } finally {
    state.pending = false;
  }
}

export function handleStaticImageFrameAnalysisDone(
  imageId: number,
  requestId?: number,
  decision?: string,
  _reason?: string,
  frameSeq?: number,
  stableMeta?: { score: number }
): void {
  const bg = imageIdToBackground.get(imageId);
  if (bg) {
    const state = backgroundTargets.get(bg);
    if (!state) {
      imageIdToBackground.delete(imageId);
      return;
    }

    const score = stableMeta?.score ?? 0;
    const shouldBlur = decision === "BLUR";
    setCachedResult(state.imageUrl, {
      score,
      shouldBlur,
      action: decision ?? "ALLOW",
      detected: shouldBlur,
    });
    applyScanResultToBackground(bg, state, {
      score,
      shouldBlur,
      action: decision ?? "ALLOW",
      detected: shouldBlur,
      scannedAt: Date.now(),
    });
    imageIdToBackground.delete(imageId);
    return;
  }

  const img = imageIdToElement.get(imageId);
  if (!img) {
    console.warn(
      "[SafeView][Image] Analysis done for id=%s but <img> not tracked (decision=%s)",
      imageId,
      decision ?? "-"
    );
    return;
  }

  const state = trackedImages.get(img);
  if (!state) {
    return;
  }

  if (requestId !== undefined && requestId > 0 && requestId < state.requestId) {
    return;
  }

  clearAnalysisTimeout(state);
  state.isAnalyzing = false;
  state.pending = false;
  state.lastScannedAt = Date.now();

  const score = stableMeta?.score ?? state.score ?? 0;
  const shouldBlur = decision === "BLUR";

  if (_reason === "image_fetch_failed") {
    console.warn("[SafeView][Image] Could not fetch image bytes for analysis");
  } else if (_reason === "backend_offline" || _reason?.includes("backend")) {
    backendOfflineUntil = Date.now() + 15_000;
    console.warn(
      "[SafeView][Image] Backend unavailable — pausing scans 15s. Run: cd backend && uvicorn main:app --host 0.0.0.0 --port 8000"
    );
  }

  console.info(
    "[SafeView][Image] Result score=%s action=%s reason=%s",
    score.toFixed(2),
    decision ?? "-",
    _reason ?? "-"
  );

  const cacheKey = imageCacheKey(img);
  if (cacheKey) {
    setCachedResult(cacheKey, {
      score,
      shouldBlur,
      action: decision ?? "ALLOW",
      detected: shouldBlur,
    });
  }

  applyScanResultToImage(img, state, {
    score,
    shouldBlur,
    action: decision ?? "ALLOW",
    detected: shouldBlur,
    scannedAt: Date.now(),
  });

  void frameSeq;
}

function unregisterImage(img: HTMLImageElement, reason: string): void {
  const state = trackedImages.get(img);
  if (!state) {
    return;
  }

  clearAnalysisTimeout(state);
  clearImageBlur(img);
  clearImageScoreLabel(img);
  imageIdToElement.delete(state.imageId);
  trackedImages.delete(img);
  delete img.dataset[SAFE_VIEW_TRACKED_DATASET];

  const idx = scanQueue.indexOf(img);
  if (idx >= 0) {
    scanQueue.splice(idx, 1);
  }

  console.info("[SafeView][Image] Unregistered id=%s reason=%s", state.imageId, reason);
}

function registerImage(img: HTMLImageElement): void {
  if (trackedImages.has(img) || img.dataset[SAFE_VIEW_TRACKED_DATASET] === "true") {
    const existing = trackedImages.get(img);
    if (existing) {
      const src = imageCacheKey(img);
      if (src && src !== existing.lastSrc) {
        existing.lastSrc = "";
        existing.corsBlocked = false;
        existing.skipCapture = false;
        enqueueImageScan(img, true);
      }
    }
    return;
  }

  if (imageIdToElement.size >= MAX_TRACKED_IMAGES) {
    return;
  }

  if (!isImageVisible(img)) {
    return;
  }

  const src = imageCacheKey(img);
  console.info("[SafeView][Image] Found image src=%s", src.slice(0, 80));

  const cached = src ? getCachedResult(src) : null;

  img.dataset[SAFE_VIEW_TRACKED_DATASET] = "true";
  const imageId = nextImageId++;
  const state: ImageScanState = {
    imageId,
    pending: false,
    lastScannedAt: 0,
    lastSrc: "",
    blurred: cached?.shouldBlur ?? false,
    isCapturing: false,
    isAnalyzing: false,
    analysisTimeoutId: null,
    lastAnalysisStartedAt: 0,
    requestId: 0,
    frameSeq: 0,
    skipCapture: false,
    corsBlocked: false,
  };

  trackedImages.set(img, state);
  imageIdToElement.set(imageId, img);

  if (cached) {
    applyScanResultToImage(img, state, cached);
  }

  img.addEventListener(
    "load",
    () => {
      const current = trackedImages.get(img);
      if (!current) {
        return;
      }
      const src = imageCacheKey(img);
      const cached = src ? getCachedResult(src) : null;
      if (cached) {
        if (src !== current.lastSrc) {
          current.lastSrc = src;
          applyScanResultToImage(img, current, cached);
        }
        return;
      }
      if (isImageSettled(img, current)) {
        return;
      }
      current.corsBlocked = false;
      current.skipCapture = false;
      if (src && src !== current.lastSrc) {
        current.lastSrc = src;
        current.blurred = false;
        clearImageBlur(img);
        enqueueImageScan(img, true);
      }
    },
    { passive: true }
  );

  img.addEventListener(
    "error",
    () => {
      const current = trackedImages.get(img);
      if (current) {
        current.skipCapture = true;
      }
    },
    { passive: true }
  );

  if (img.complete && isInViewport(img) && !cached) {
    enqueueImageScan(img, true);
  }
}

function extractBackgroundUrl(backgroundImage: string): string | null {
  const match = /url\(["']?([^"')]+)["']?\)/i.exec(backgroundImage);
  return match?.[1] ?? null;
}

function registerBackgroundElement(element: HTMLElement): void {
  if (backgroundTargets.has(element) || element.dataset[SAFE_VIEW_BG_TRACKED] === "true") {
    return;
  }

  const style = window.getComputedStyle(element);
  const url = extractBackgroundUrl(style.backgroundImage);
  if (!url) {
    return;
  }

  const { width, height } = layoutSize(element);
  if (shouldSkipTiny(width, height)) {
    return;
  }

  element.dataset[SAFE_VIEW_BG_TRACKED] = "true";
  const cached = getCachedResult(url);
  if (cached?.shouldBlur) {
    applyElementImageBlur(element);
  }

  backgroundTargets.set(element, {
    element,
    imageUrl: url,
    pending: false,
    lastScannedAt: 0,
    blurred: cached?.shouldBlur ?? false,
  });
  backgroundElements.add(element);
  void scanBackgroundElement(element);
}

function collectImages(root: ParentNode): HTMLImageElement[] {
  const images: HTMLImageElement[] = [];
  if (root instanceof HTMLImageElement) {
    images.push(root);
  }
  root.querySelectorAll("picture img, img").forEach((img) => {
    if (img instanceof HTMLImageElement) {
      images.push(img);
    }
  });
  return images;
}

function collectBackgroundElements(root: ParentNode): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const nodes =
    root instanceof Element
      ? root.querySelectorAll("*")
      : document.querySelectorAll("*");

  nodes.forEach((node) => {
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (elements.length >= MAX_BACKGROUND_TARGETS) {
      return;
    }
    const bg = window.getComputedStyle(node).backgroundImage;
    if (bg && bg !== "none" && bg.includes("url(")) {
      elements.push(node);
    }
  });

  return elements;
}

function scanDocument(root: ParentNode = document): void {
  if (!isNudityActiveCached()) {
    return;
  }

  for (const img of collectImages(root)) {
    registerImage(img);
  }

  for (const el of collectBackgroundElements(root)) {
    registerBackgroundElement(el);
  }
}

function pruneStaleImages(): void {
  for (const img of [...imageIdToElement.values()]) {
    if (!img.isConnected) {
      unregisterImage(img, "disconnected");
    }
  }
}

function scheduleDebouncedScan(): void {
  if (debounceTimerId !== null) {
    clearTimeout(debounceTimerId);
  }
  debounceTimerId = window.setTimeout(() => {
    debounceTimerId = null;
    scanDocument(document);
    pruneStaleImages();
  }, IMAGE_SCAN_DEBOUNCE_MS);
}

function needsBackendScan(img: HTMLImageElement): boolean {
  if (!isImageVisible(img)) {
    return false;
  }
  const state = trackedImages.get(img);
  if (state?.pending || state?.isCapturing || state?.isAnalyzing) {
    return false;
  }
  const src = imageCacheKey(img);
  if (!src) {
    return false;
  }
  if (getCachedResult(src) !== null) {
    return false;
  }
  if (state && isImageSettled(img, state)) {
    return false;
  }
  if (state?.blurred && state.lastScannedAt > 0 && src === state.lastSrc) {
    return false;
  }
  return true;
}

function scheduleUncachedImageScans(limit: number): void {
  const candidates = [...imageIdToElement.values()]
    .filter((img) => needsBackendScan(img))
    .sort((a, b) => {
      const aVp = isInViewport(a) ? 0 : 1;
      const bVp = isInViewport(b) ? 0 : 1;
      if (aVp !== bVp) {
        return aVp - bVp;
      }
      const aState = trackedImages.get(a);
      const bState = trackedImages.get(b);
      const aNew = aState?.lastScannedAt === 0 ? 0 : 1;
      const bNew = bState?.lastScannedAt === 0 ? 0 : 1;
      return aNew - bNew;
    });

  const batchLimit = Math.min(candidates.length, limit);
  let scheduled = 0;
  for (const img of candidates) {
    if (scheduled >= batchLimit) {
      break;
    }
    enqueueImageScan(img, scheduled < 8);
    scheduled += 1;
  }

  if (scheduled > 0) {
    const pending = candidates.length - scheduled;
    console.info(
      "[SafeView][Image] Queued %s scan(s), %s uncached image(s) remain",
      scheduled,
      pending
    );
  }
}

function scheduleScrollScan(): void {
  if (scrollScanTimerId !== null) {
    clearTimeout(scrollScanTimerId);
  }
  scrollScanTimerId = window.setTimeout(() => {
    scrollScanTimerId = null;
    scheduleUncachedImageScans(IMAGE_BATCH_PER_RESCAN);
  }, IMAGE_SCROLL_SCAN_DEBOUNCE_MS);
}

function setupScrollScanListener(): void {
  if (scrollListenerRegistered) {
    return;
  }
  scrollListenerRegistered = true;
  window.addEventListener("scroll", scheduleScrollScan, { passive: true, capture: true });
}

function handleMutations(mutations: MutationRecord[]): void {
  let needsScan = false;

  for (const mutation of mutations) {
    mutation.addedNodes.forEach((node) => {
      if (node instanceof HTMLImageElement) {
        registerImage(node);
        needsScan = true;
      } else if (node instanceof Element) {
        scanDocument(node);
        needsScan = true;
      }
    });

    mutation.removedNodes.forEach((node) => {
      if (node instanceof HTMLImageElement) {
        unregisterImage(node, "removed");
      } else if (node instanceof Element) {
        collectImages(node).forEach((img) => unregisterImage(img, "removed-child"));
      }
    });

    if (mutation.type === "attributes" && mutation.target instanceof HTMLImageElement) {
      const img = mutation.target;
      const state = trackedImages.get(img);
      if (state) {
        state.lastSrc = "";
        state.corsBlocked = false;
        state.skipCapture = false;
        enqueueImageScan(img, true);
      } else {
        registerImage(img);
      }
    }
  }

  if (needsScan) {
    scheduleDebouncedScan();
  } else {
    pruneStaleImages();
  }
}

function startObservers(): void {
  if (observer) {
    return;
  }

  observer = new MutationObserver(handleMutations);
  const target = document.body ?? document.documentElement;
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style"],
  });

  rescanIntervalId = window.setInterval(() => {
    scanDocument(document);
    pruneStaleImages();
    scheduleUncachedImageScans(IMAGE_BATCH_PER_RESCAN);
  }, IMAGE_RESCAN_INTERVAL_MS);

  setupScrollScanListener();
  console.info("[SafeView][Image] MutationObserver attached");
}

function stopObservers(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (rescanIntervalId !== null) {
    clearInterval(rescanIntervalId);
    rescanIntervalId = null;
  }
  if (bootstrapTimeoutId !== null) {
    clearTimeout(bootstrapTimeoutId);
    bootstrapTimeoutId = null;
  }
  if (debounceTimerId !== null) {
    clearTimeout(debounceTimerId);
    debounceTimerId = null;
  }
}

export async function rescanStaticImages(): Promise<void> {
  cachedContentSettings = await loadSettings();

  if (!isNudityProtectionActive(cachedContentSettings)) {
    stopObservers();
    for (const img of [...imageIdToElement.values()]) {
      unregisterImage(img, "nudity-off");
    }
    for (const el of backgroundElements) {
      clearElementImageBlur(el);
    }
    backgroundElements.clear();
    imageIdToBackground.clear();
    resultCache.clear();
    scanQueue.length = 0;
    console.info("[SafeView][Image] Nudity protection off — image scan stopped.");
    return;
  }

  startObservers();
  scanDocument(document);
  pruneStaleImages();
  scheduleUncachedImageScans(IMAGE_BATCH_PER_RESCAN);
  console.info(
    "[SafeView][Image] Rescan complete — %s image(s) on %s",
    imageIdToElement.size,
    location.hostname
  );
}

function setupSettingsStorageListener(): void {
  if (settingsListenerRegistered) {
    return;
  }
  settingsListenerRegistered = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || changes[SETTINGS_STORAGE_KEY] === undefined) {
      return;
    }
    void rescanStaticImages();
  });
}

export function startStaticImageMonitor(): void {
  setupSettingsStorageListener();
  console.info("[SafeView][Image] Bootstrap on %s", location.href);

  const runBootstrap = (): void => {
    void rescanStaticImages();
    bootstrapTimeoutId = window.setTimeout(() => {
      void rescanStaticImages();
    }, IMAGE_BOOTSTRAP_DELAY_MS);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runBootstrap, { once: true });
  } else {
    runBootstrap();
  }
}

export function stopStaticImageMonitor(): void {
  stopObservers();
  for (const img of [...imageIdToElement.values()]) {
    unregisterImage(img, "stop");
  }
  for (const el of backgroundElements) {
    clearElementImageBlur(el);
  }
  backgroundElements.clear();
  imageIdToBackground.clear();
  imageIdToElement.clear();
  scanQueue.length = 0;
  console.info("[SafeView][Image] Monitor stopped.");
}

/** @deprecated Use startStaticImageMonitor */
export const startImageMonitor = startStaticImageMonitor;

/** @deprecated Use stopStaticImageMonitor */
export const stopImageMonitor = stopStaticImageMonitor;
