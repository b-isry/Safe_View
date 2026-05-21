// SafeView — serviceWorker.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: MV3 service worker — receive frames, call backend, send BLUR/CLEAR to tabs.

import { analyzeImage, loadBackendStatusFromStorage } from "./aiClient";
import {
  CONFIDENCE_FLOOR,
  effectiveThreshold,
  getEnabledCategories,
  loadSettings,
  shouldBlur,
} from "./businessRules";
import {
  OPTIMISTIC_BLUR_SCORE_FLOOR,
  OPTIMISTIC_CLEAR_STREAK,
  SERVICE_WORKER_KEEPALIVE_MS,
} from "./latencyPolicy";

/** Content script → service worker: JPEG frame sample. */
export const MESSAGE_ACTION_FRAME_SAMPLE = "FRAME_SAMPLE";

/** Service worker → content script: apply blur. */
export const MESSAGE_ACTION_BLUR = "BLUR";

/** Service worker → content script: remove blur. */
export const MESSAGE_ACTION_CLEAR = "CLEAR";

/**
 * Frame sample message from the content script.
 */
export interface FrameSampleMessage {
  action: typeof MESSAGE_ACTION_FRAME_SAMPLE;
  videoId: number;
  /** JPEG as base64 — reliable through chrome.runtime.sendMessage structured clone. */
  frameBase64: string;
  frameMimeType?: string;
  /** Content script build id (manifest version) for stale-tab detection. */
  contentBuild?: string;
  /** performance.now() when the frame JPEG was ready in the content script. */
  capturedAt?: number;
  /** performance.now() immediately before chrome.runtime.sendMessage. */
  sentAt?: number;
}

/**
 * Blur command sent to a tab content script.
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
 * Per-tab/video optimistic blur state (client latency policy only).
 */
interface OptimisticBlurState {
  consecutiveLowScoreCount: number;
}

const DEFAULT_FRAME_MIME_TYPE = "image/jpeg";

/** Throttle "below sensitivity threshold" console hints (ms). */
const THRESHOLD_HINT_INTERVAL_MS = 5000;

let lastThresholdHintAt = 0;

const optimisticBlurState = new Map<string, OptimisticBlurState>();

/**
 * Stable key for per-video optimistic blur tracking.
 *
 * @param tabId - Chrome tab id.
 * @param videoId - Content-script video id.
 * @returns Map key string.
 */
function optimisticStateKey(tabId: number, videoId: number): string {
  return `${tabId}:${videoId}`;
}

/**
 * Decode base64 JPEG bytes from the content script into a Blob for /analyze-image.
 *
 * @param base64 - Base64-encoded JPEG from FRAME_SAMPLE.
 * @param mimeType - MIME type for the reconstructed Blob.
 * @returns Blob for analyze-image, or null when decoding fails.
 */
function base64ToBlob(base64: string, mimeType: string): Blob | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

/**
 * Rebuild a JPEG Blob from the content script's base64 payload.
 *
 * @param message - FRAME_SAMPLE message from the content script.
 * @returns Blob for analyze-image, or null when bytes are missing.
 */
function frameFromMessage(message: FrameSampleMessage): Blob | null {
  if (typeof message.frameBase64 !== "string" || message.frameBase64.length === 0) {
    return null;
  }

  const mimeType = message.frameMimeType || DEFAULT_FRAME_MIME_TYPE;
  return base64ToBlob(message.frameBase64, mimeType);
}

/**
 * True when the service worker should command BLUR (BR-01 hit or optimistic ≥0.65).
 *
 * @param outcome - Backend analysis for this frame.
 * @returns True to send BLUR to the content script.
 */
function shouldCommandBlur(outcome: FrameAnalysisOutcome): boolean {
  if (outcome.blurRequired) {
    return true;
  }

  return (
    outcome.nudityConfidence !== null &&
    outcome.nudityConfidence >= OPTIMISTIC_BLUR_SCORE_FLOOR
  );
}

/**
 * True when enough consecutive low-score frames justify CLEAR.
 *
 * @param tabId - Chrome tab id.
 * @param videoId - Content-script video id.
 * @param outcome - Backend analysis for this frame.
 * @returns True to send CLEAR to the content script.
 */
function shouldCommandClear(
  tabId: number,
  videoId: number,
  outcome: FrameAnalysisOutcome
): boolean {
  const key = optimisticStateKey(tabId, videoId);
  let state = optimisticBlurState.get(key);

  if (!state) {
    state = { consecutiveLowScoreCount: 0 };
    optimisticBlurState.set(key, state);
  }

  if (shouldCommandBlur(outcome)) {
    state.consecutiveLowScoreCount = 0;
    return false;
  }

  const confidence = outcome.nudityConfidence ?? 0;
  if (confidence < OPTIMISTIC_BLUR_SCORE_FLOOR) {
    state.consecutiveLowScoreCount += 1;
  } else {
    state.consecutiveLowScoreCount = 0;
  }

  return state.consecutiveLowScoreCount >= OPTIMISTIC_CLEAR_STREAK;
}

/**
 * Log end-to-end latency for one frame (console only — no pixel data).
 *
 * @param tabId - Chrome tab id.
 * @param videoId - Content-script video id.
 * @param message - Frame sample with content-script timestamps.
 * @param swReceivedAt - performance.now() when the SW handler started.
 * @param backendDoneAt - performance.now() after /analyze-image returned.
 * @param command - BLUR or CLEAR.
 */
function logPipelineLatency(
  tabId: number,
  videoId: number,
  message: FrameSampleMessage,
  swReceivedAt: number,
  backendDoneAt: number,
  command: typeof MESSAGE_ACTION_BLUR | typeof MESSAGE_ACTION_CLEAR
): void {
  const capturedAt = message.capturedAt;
  const sentAt = message.sentAt;

  if (capturedAt === undefined) {
    return;
  }

  const swMs =
    sentAt !== undefined ? Math.round(swReceivedAt - sentAt) : undefined;
  const backendMs = Math.round(backendDoneAt - swReceivedAt);
  const totalToBackendMs = Math.round(backendDoneAt - capturedAt);

  console.info(
    "[SafeView][Latency] tab=%s video=%s command=%s | encode+send→SW=%sms backend=%sms capture→backend=%sms (blur apply logged in content script)",
    tabId,
    videoId,
    command,
    swMs ?? "?",
    backendMs,
    totalToBackendMs
  );
}

/**
 * Send BLUR or CLEAR to the content script for a specific tab/video.
 *
 * @param tabId - Chrome tab id that sent the frame.
 * @param action - BLUR or CLEAR.
 * @param videoId - Target video element id.
 * @param trace - Optional latency timestamps for content-script logging.
 */
export async function sendBlurCommand(
  tabId: number,
  action: typeof MESSAGE_ACTION_BLUR | typeof MESSAGE_ACTION_CLEAR,
  videoId: number,
  trace?: Pick<BlurCommandMessage, "capturedAt" | "sentAt" | "swReceivedAt" | "backendDoneAt">
): Promise<void> {
  const message: BlurCommandMessage = { action, videoId, ...trace };

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn(
      "[SafeView] Could not deliver %s to tab %s (video %s):",
      action,
      tabId,
      videoId,
      error
    );
  }
}

/**
 * Outcome of one frame analysis pass (for BLUR/CLEAR and debug logs).
 */
export interface FrameAnalysisOutcome {
  blurRequired: boolean;
  categories: string[];
  nudityConfidence: number | null;
  nudityDetected: boolean | null;
  nudityAction: string | null;
}

/**
 * Run enabled category checks; return true if any category triggers blur (BR-01).
 *
 * @param frame - JPEG blob from the content script.
 * @param settings - User settings from storage.
 * @returns True when any enabled category exceeds the BR-01 threshold.
 */
export async function analyzeFrameAgainstEnabledCategories(
  frame: Blob,
  settings: Awaited<ReturnType<typeof loadSettings>>
): Promise<FrameAnalysisOutcome> {
  const categories = getEnabledCategories(settings);

  if (categories.length === 0) {
    return {
      blurRequired: false,
      categories,
      nudityConfidence: null,
      nudityDetected: null,
      nudityAction: null,
    };
  }

  let nudityConfidence: number | null = null;
  let nudityDetected: boolean | null = null;
  let nudityAction: string | null = null;

  for (const category of categories) {
    const result = await analyzeImage(frame, settings.sensitivity, category);

    if (!result.backendOnline || result.fromFallback) {
      return {
        blurRequired: false,
        categories,
        nudityConfidence,
        nudityDetected,
        nudityAction,
      };
    }

    if (category === "nudity") {
      nudityConfidence = result.response.confidence;
      nudityDetected = result.response.detected;
      nudityAction = result.response.action;
    }

    if (
      result.response.action === "BLUR" ||
      result.response.detected ||
      shouldBlur(result.response.confidence, settings.sensitivity)
    ) {
      return {
        blurRequired: true,
        categories,
        nudityConfidence,
        nudityDetected,
        nudityAction,
      };
    }
  }

  return {
    blurRequired: false,
    categories,
    nudityConfidence,
    nudityDetected,
    nudityAction,
  };
}

/**
 * Handle one FRAME_SAMPLE message: backend inference then BLUR/CLEAR.
 *
 * @param message - Frame sample from the content script.
 * @param sender - Message sender metadata (tab id required).
 */
export async function handleFrameSample(
  message: FrameSampleMessage,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  const tabId = sender.tab?.id;

  if (tabId === undefined) {
    console.warn("[SafeView] FRAME_SAMPLE ignored — missing tab id.");
    return;
  }

  const swReceivedAt = performance.now();
  const settings = await loadSettings();
  const frame = frameFromMessage(message);

  if (!frame) {
    console.warn("[SafeView] FRAME_SAMPLE ignored — invalid frame buffer.");
    return;
  }

  if (!settings.protectionEnabled) {
    optimisticBlurState.delete(optimisticStateKey(tabId, message.videoId));
    await sendBlurCommand(tabId, MESSAGE_ACTION_CLEAR, message.videoId);
    return;
  }

  try {
    const outcome = await analyzeFrameAgainstEnabledCategories(frame, settings);
    const backendDoneAt = performance.now();

    const extensionVersion = chrome.runtime.getManifest().version;
    const contentBuild = message.contentBuild ?? "unknown";
    const contentStale = contentBuild !== extensionVersion;

    if (contentStale && outcome.blurRequired) {
      console.warn(
        "[SafeView] Tab content script is stale (content %s, extension %s). Reload the YouTube tab after updating the extension.",
        contentBuild,
        extensionVersion
      );
    }

    const threshold = effectiveThreshold(settings.sensitivity);
    if (
      !outcome.blurRequired &&
      outcome.nudityConfidence !== null &&
      outcome.nudityConfidence >= CONFIDENCE_FLOOR &&
      outcome.nudityConfidence < threshold
    ) {
      const now = Date.now();
      if (now - lastThresholdHintAt >= THRESHOLD_HINT_INTERVAL_MS) {
        lastThresholdHintAt = now;
        console.info(
          "[SafeView] Nudity score %.2f is below your sensitivity threshold %.2f — set sensitivity to Medium in extension options to blur at ≥75%%.",
          outcome.nudityConfidence,
          threshold
        );
      }
    }

    const trace = {
      capturedAt: message.capturedAt,
      sentAt: message.sentAt,
      swReceivedAt,
      backendDoneAt,
    };

    if (shouldCommandBlur(outcome)) {
      logPipelineLatency(
        tabId,
        message.videoId,
        message,
        swReceivedAt,
        backendDoneAt,
        MESSAGE_ACTION_BLUR
      );
      await sendBlurCommand(tabId, MESSAGE_ACTION_BLUR, message.videoId, trace);
    } else if (shouldCommandClear(tabId, message.videoId, outcome)) {
      logPipelineLatency(
        tabId,
        message.videoId,
        message,
        swReceivedAt,
        backendDoneAt,
        MESSAGE_ACTION_CLEAR
      );
      await sendBlurCommand(tabId, MESSAGE_ACTION_CLEAR, message.videoId, trace);
    }
  } catch (error) {
    console.error("[SafeView] Frame handling failed — failing open:", error);
    await sendBlurCommand(tabId, MESSAGE_ACTION_CLEAR, message.videoId);
  }
}

/**
 * Route runtime messages from content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.action !== MESSAGE_ACTION_FRAME_SAMPLE) {
    return false;
  }

  const frameMessage = message as FrameSampleMessage;

  if (
    typeof frameMessage.videoId !== "number" ||
    typeof frameMessage.frameBase64 !== "string" ||
    frameMessage.frameBase64.length === 0
  ) {
    console.warn("[SafeView] Invalid FRAME_SAMPLE payload.");
    sendResponse({ ok: false });
    return false;
  }

  sendResponse({ ok: true });
  void handleFrameSample(frameMessage, sender).catch((error) => {
    console.error("[SafeView] FRAME_SAMPLE handler error:", error);
  });

  return false;
});

/**
 * Keep the service worker warm between frame samples (reduces ~300ms cold-start).
 */
function startServiceWorkerKeepalive(): void {
  if (typeof process !== "undefined" && process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  setInterval(() => {
    void chrome.storage.local.get(null).catch(() => {});
  }, SERVICE_WORKER_KEEPALIVE_MS);
}

void loadBackendStatusFromStorage();
startServiceWorkerKeepalive();

console.info(
  "[SafeView] Service worker loaded (v%s, nudity-only, optimistic blur ≥%.2f).",
  chrome.runtime.getManifest().version,
  OPTIMISTIC_BLUR_SCORE_FLOOR
);
