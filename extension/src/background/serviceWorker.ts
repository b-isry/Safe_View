// SafeView — serviceWorker.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: MV3 service worker — receive frames, call backend, send BLUR/CLEAR to tabs.

import { analyzeAudio, analyzeImage, loadBackendStatusFromStorage } from "./aiClient";
import {
  evaluateBlurState,
  logBlurEvaluation,
  normalizeBlurLabel,
  type BlurLabel,
  type CategoryBlurResult,
} from "./blurDecision";
import {
  CONFIDENCE_FLOOR,
  MUTE_DURATION_MS,
  SETTINGS_STORAGE_KEY,
  effectiveThreshold,
  getCachedSettings,
  getEnabledCategories,
  initSettingsCache,
  isNudityProtectionActive,
  loadSettings,
  type SafeViewSettings,
} from "./businessRules";
import {
  MAX_APPLY_TIME_DRIFT_SEC,
  MIN_CONFIRMED_UNSAFE_HOLD_MS,
  CONTENT_BLUR_THRESHOLD,
  SERVICE_WORKER_KEEPALIVE_MS,
  STALE_RESPONSE_MS,
  ANIMATION_SKIP_THRESHOLD,
} from "./latencyPolicy";
import { detailLog } from "../shared/detailLog";
import { MESSAGE_ACTION_SETTINGS_UPDATED } from "../shared/settingsMessages";

/** Content script → service worker: JPEG frame sample. */
export const MESSAGE_ACTION_FRAME_SAMPLE = "FRAME_SAMPLE";

/** Content script → service worker: WebM audio chunk. */
export const MESSAGE_ACTION_AUDIO_CHUNK = "AUDIO_CHUNK";

/** Service worker → content script: mute video (BR-05). */
export const MESSAGE_ACTION_MUTE = "MUTE";

/** Service worker → content script: apply blur. */
export const MESSAGE_ACTION_BLUR = "BLUR";

/** Service worker → content script: remove blur. */
export const MESSAGE_ACTION_CLEAR = "CLEAR";

/** Service worker → content script: frame analysis finished (clears in-flight gate). */
export const MESSAGE_ACTION_FRAME_ANALYSIS_DONE = "FRAME_ANALYSIS_DONE";

/** Service worker → offscreen document: begin tab-capture audio pipeline. */
export const MESSAGE_ACTION_INIT_AUDIO_PIPELINE = "INIT_AUDIO_PIPELINE";

/** Service worker → offscreen document: tear down audio pipeline. */
export const MESSAGE_ACTION_STOP_AUDIO_PIPELINE = "STOP_AUDIO_PIPELINE";

/** Offscreen document → service worker: profanity detected in captured audio. */
export const MESSAGE_ACTION_PROFANITY_DETECTED = "PROFANITY_DETECTED";

/** Offscreen scout path → service worker: WebM chunk for Whisper backend. */
export const MESSAGE_ACTION_AUDIO_CHUNK_PIPELINE = "AUDIO_CHUNK_PIPELINE";

/** Service worker → offscreen document: apply gain mute for BR-05 duration. */
export const MESSAGE_ACTION_MUTE_GAIN = "MUTE_GAIN";

/** Popup → service worker: begin pipeline with streamId from user-gesture tabCapture. */
export const MESSAGE_ACTION_START_PIPELINE_WITH_STREAM =
  "START_PIPELINE_WITH_STREAM";

/** Service worker → content script: mute page <video> speakers (H5 dual-audio). */
export const MESSAGE_ACTION_SET_TAB_SPEAKER_SUPPRESSED =
  "SET_TAB_SPEAKER_SUPPRESSED";

/** Offscreen → service worker: tab capture failed. */
export const MESSAGE_ACTION_TAB_CAPTURE_INIT_FAILED = "TAB_CAPTURE_INIT_FAILED";

/** Offscreen → service worker: tab capture stream is silent. */
export const MESSAGE_ACTION_TAB_CAPTURE_SILENT_STREAM =
  "TAB_CAPTURE_SILENT_STREAM";

/** Service worker → content script: native video element audio fallback. */
export const MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK =
  "START_ELEMENT_AUDIO_FALLBACK";

/** Service worker → content script: stop element audio fallback. */
export const MESSAGE_ACTION_STOP_ELEMENT_AUDIO_FALLBACK =
  "STOP_ELEMENT_AUDIO_FALLBACK";

/** Service worker → content script: mute element-path gain. */
export const MESSAGE_ACTION_ELEMENT_MUTE_GAIN = "ELEMENT_MUTE_GAIN";

/** Service worker / content: force pipeline gain nodes back to 1.0. */
export const MESSAGE_ACTION_RESET_PIPELINE_GAIN = "RESET_PIPELINE_GAIN";

/** Content script → service worker: YouTube SPA navigation / watch id change. */
export const MESSAGE_ACTION_PIPELINE_NAVIGATION = "PIPELINE_NAVIGATION";

/** Offscreen document HTML path (built to dist/offscreen/). */
const OFFSCREEN_AUDIO_PROCESSOR_URL = "dist/offscreen/audioProcessor.html";

/**
 * Frame sample message from the content script.
 */
export interface FrameSampleMessage {
  action: typeof MESSAGE_ACTION_FRAME_SAMPLE;
  videoId: number;
  /** JPEG bytes as number[] — reliable through chrome.runtime structured clone. */
  framePayload?: number[];
  /** @deprecated Legacy; may arrive as plain Object after clone — use framePayload. */
  frameBuffer?: ArrayBuffer | Uint8Array | Record<string, number>;
  /** @deprecated Legacy base64 transport — still accepted for tests. */
  frameBase64?: string;
  frameMimeType?: string;
  /** Content script build id (manifest version) for stale-tab detection. */
  contentBuild?: string;
  /** Date.now() when the frame JPEG was ready in the content script. */
  capturedAt?: number;
  /** Date.now() immediately before chrome.runtime.sendMessage. */
  sentAt?: number;
  /** Monotonic per-video frame id for latest-frame-wins. */
  frameSeq?: number;
  /** Monotonic request id for stale-response protection. */
  requestId?: number;
  /** drawImage + blank-check duration (ms). */
  captureMs?: number;
  /** canvas.toBlob duration (ms). */
  encodeMs?: number;
  /** Content-script capture session (navigation invalidation). */
  captureSession?: number;
  /** video.currentTime when the frame was captured. */
  capturedVideoTime?: number;
}

/**
 * Audio chunk message from the content script.
 */
export interface AudioChunkMessage {
  action: typeof MESSAGE_ACTION_AUDIO_CHUNK;
  videoId: number;
  audioBase64: string;
  language: string;
}

/**
 * Mute command sent to a tab content script.
 */
export interface MuteCommandMessage {
  action: typeof MESSAGE_ACTION_MUTE;
  videoId: number;
  duration_ms: number;
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
  /** Monotonic command id — content script ignores stale BLUR/CLEAR. */
  commandSeq?: number;
  /** True when blur is applied before backend confirms (latency policy). */
  preemptive?: boolean;
  /** video.currentTime when the analyzed frame was captured. */
  capturedVideoTime?: number;
}

/**
 * Per-tab/video frame analysis pipeline (latest-frame-wins).
 */
interface FramePipelineState {
  generation: number;
  abortController: AbortController | null;
  analysisInFlight: boolean;
  lastUnsafe: boolean;
  lastBlurCommandSeq: number;
  lastProcessedFrameSeq: number;
  /** Latest requestId accepted for this video pipeline. */
  latestRequestId: number;
  /** True after the first trusted backend blur decision. */
  firstDecisionMade: boolean;
  /** Consecutive clearly-safe frames while blurred. */
  safeStreak: number;
  /** True once a trusted unsafe BLUR was applied for this video. */
  confirmedUnsafe: boolean;
  /** Earliest time (ms) a CLEAR may follow confirmed unsafe. */
  unsafeLockUntil: number;
  /** Count of ignored unsafe results due to time drift (diagnostic). */
  ignoredUnsafeDriftCount: number;
  /** Capture session id from content script (stale-response guard). */
  captureSession: number;
  /** Latest frame while analysis is in flight (coalesced, not aborted). */
  pendingSample: FrameSampleMessage | null;
}

const DEFAULT_FRAME_MIME_TYPE = "image/jpeg";

/** Throttle "below sensitivity threshold" console hints (ms). */
const THRESHOLD_HINT_INTERVAL_MS = 5000;

let lastThresholdHintAt = 0;

const framePipelineState = new Map<string, FramePipelineState>();

/** Tab id currently wired to the offscreen tab-capture pipeline, if any. */
let activeAudioPipelineTabId: number | undefined;

/** Active audio path: offscreen tabCapture or content-script video element. */
type AudioPipelineMode = "offscreen" | "element" | null;

let audioPipelineMode: AudioPipelineMode = null;

/** Max in-flight /analyze-audio calls per tab (offscreen scout path). */
const MAX_CONCURRENT_AUDIO = 2;

/** Per-tab pipeline audio analysis in progress. */
const audioProcessingCount = new Map<number, number>();

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
 * Rebuild bytes when structured clone turns Uint8Array into a plain Object (numeric keys).
 *
 * @param raw - frameBuffer field after chrome.runtime.sendMessage.
 * @returns Uint8Array or null.
 */
function uint8ArrayFromClonePayload(raw: unknown): Uint8Array | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const tag = Object.prototype.toString.call(raw);
  if (tag === "[object Uint8Array]") {
    const bytes = raw as Uint8Array;
    return bytes.byteLength > 0 ? bytes : null;
  }

  if (tag === "[object ArrayBuffer]") {
    const buffer = raw as ArrayBuffer;
    return buffer.byteLength > 0 ? new Uint8Array(buffer) : null;
  }

  if (Array.isArray(raw)) {
    const numbers = raw as number[];
    return numbers.length > 0 ? new Uint8Array(numbers) : null;
  }

  if (tag === "[object Object]") {
    const record = raw as Record<string, unknown>;
    const numericKeys = Object.keys(record).filter((key) => /^\d+$/.test(key));
    if (numericKeys.length === 0) {
      return null;
    }

    const maxIndex = numericKeys.reduce(
      (max, key) => Math.max(max, Number(key)),
      0
    );
    const out = new Uint8Array(maxIndex + 1);
    for (const key of numericKeys) {
      const value = record[key];
      if (typeof value === "number") {
        out[Number(key)] = value & 0xff;
      }
    }
    return out.byteLength > 0 ? out : null;
  }

  return null;
}

/**
 * True when the message carries decodable JPEG bytes.
 *
 * @param message - FRAME_SAMPLE from content script.
 * @returns True when framePayload or frameBuffer can be decoded.
 */
function hasDecodableFrameBytes(message: FrameSampleMessage): boolean {
  if (Array.isArray(message.framePayload) && message.framePayload.length > 0) {
    return true;
  }

  if (typeof message.frameBase64 === "string" && message.frameBase64.length > 0) {
    return true;
  }

  return uint8ArrayFromClonePayload(message.frameBuffer as unknown) !== null;
}

/**
 * Extract JPEG bytes from a FRAME_SAMPLE message (cross-realm + clone safe).
 *
 * @param message - FRAME_SAMPLE from content script.
 * @returns Uint8Array or null.
 */
function getFrameBytesFromMessage(message: FrameSampleMessage): Uint8Array | null {
  if (Array.isArray(message.framePayload) && message.framePayload.length > 0) {
    return new Uint8Array(message.framePayload);
  }

  return uint8ArrayFromClonePayload(message.frameBuffer as unknown);
}

/**
 * Rebuild a JPEG Blob from the content script's base64 payload.
 *
 * @param message - FRAME_SAMPLE message from the content script.
 * @returns Blob for analyze-image, or null when bytes are missing.
 */
function frameFromMessage(message: FrameSampleMessage): Blob | null {
  const mimeType = message.frameMimeType || DEFAULT_FRAME_MIME_TYPE;

  const bytes = getFrameBytesFromMessage(message);
  if (bytes) {
    return new Blob([bytes], { type: mimeType });
  }

  if (typeof message.frameBase64 === "string" && message.frameBase64.length > 0) {
    return base64ToBlob(message.frameBase64, mimeType);
  }

  return null;
}

/**
 * Return or create latest-frame-wins pipeline state for a tab/video pair.
 *
 * @param tabId - Chrome tab id.
 * @param videoId - Content-script video id.
 * @returns Mutable pipeline state.
 */
function getFramePipelineState(tabId: number, videoId: number): FramePipelineState {
  const key = optimisticStateKey(tabId, videoId);
  let state = framePipelineState.get(key);

  if (!state) {
    state = {
      generation: 0,
      abortController: null,
      analysisInFlight: false,
      lastUnsafe: false,
      lastBlurCommandSeq: 0,
      lastProcessedFrameSeq: 0,
      latestRequestId: 0,
      firstDecisionMade: false,
      safeStreak: 0,
      confirmedUnsafe: false,
      unsafeLockUntil: 0,
      ignoredUnsafeDriftCount: 0,
      captureSession: 0,
      pendingSample: null,
    };
    framePipelineState.set(key, state);
  }

  return state;
}

/**
 * Allocate the next blur command sequence for a tab/video.
 *
 * @param tabId - Chrome tab id.
 * @param videoId - Content-script video id.
 * @returns New command sequence number.
 */
function nextBlurCommandSeq(tabId: number, videoId: number): number {
  const pipeline = getFramePipelineState(tabId, videoId);
  pipeline.lastBlurCommandSeq += 1;
  return pipeline.lastBlurCommandSeq;
}

/**
 * True when a DOMException represents an aborted fetch / analysis.
 *
 * @param error - Caught rejection value.
 * @returns True for AbortError.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Log end-to-end latency for one frame (console only — no pixel data).
 *
 * @param tabId - Chrome tab id.
 * @param videoId - Content-script video id.
 * @param message - Frame sample with content-script timestamps.
 * @param swReceivedAt - Date.now() when the SW handler started.
 * @param backendDoneAt - Date.now() after /analyze-image returned.
 * @param command - BLUR or CLEAR.
 */
function logPipelineLatency(
  tabId: number,
  videoId: number,
  message: FrameSampleMessage,
  swReceivedAt: number,
  backendDoneAt: number,
  command: typeof MESSAGE_ACTION_BLUR | typeof MESSAGE_ACTION_CLEAR,
  inferenceMs?: number
): void {
  const capturedAt = message.capturedAt;
  const sentAt = message.sentAt;

  if (capturedAt === undefined) {
    return;
  }

  const transportMs =
    sentAt !== undefined ? Math.round(swReceivedAt - sentAt) : undefined;
  const backendMs = Math.round(backendDoneAt - swReceivedAt);
  const totalMs = Math.round(backendDoneAt - capturedAt);

  console.info(
    "[SafeView][Latency] tab=%s video=%s frameSeq=%s command=%s | capture=%sms encode=%sms transport→SW=%sms backend=%sms inference=%sms total→decision=%sms",
    tabId,
    videoId,
    message.frameSeq ?? "?",
    command,
    message.captureMs ?? "?",
    message.encodeMs ?? "?",
    transportMs ?? "?",
    backendMs,
    inferenceMs ?? "?",
    totalMs
  );
}

/**
 * Send MUTE to the content script for a specific tab/video (BR-05).
 *
 * @param tabId - Chrome tab id that sent the audio chunk.
 * @param videoId - Target video element id.
 * @param durationMs - Mute hold duration from backend (expected 1500).
 */
export async function sendMuteCommand(
  tabId: number,
  videoId: number,
  durationMs: number = MUTE_DURATION_MS
): Promise<void> {
  const message: MuteCommandMessage = {
    action: MESSAGE_ACTION_MUTE,
    videoId,
    duration_ms: durationMs,
  };

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn(
      "[SafeView] Could not deliver MUTE to tab %s (video %s):",
      tabId,
      videoId,
      error
    );
  }
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
  trace?: Pick<
    BlurCommandMessage,
    | "capturedAt"
    | "sentAt"
    | "swReceivedAt"
    | "backendDoneAt"
    | "preemptive"
    | "capturedVideoTime"
  >
): Promise<void> {
  const commandSeq = nextBlurCommandSeq(tabId, videoId);
  const message: BlurCommandMessage = { action, videoId, commandSeq, ...trace };

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
  label: BlurLabel;
  score: number;
  categories: string[];
  backendTrusted: boolean;
  animationScore: number;
  nudity: CategoryBlurResult;
  violence: CategoryBlurResult;
  kissing: CategoryBlurResult;
}

function emptyCategoryResult(): CategoryBlurResult {
  return {
    analyzed: false,
    detected: false,
    action: null,
    score: 0,
    label: "SFW",
  };
}

function isCategoryOutcomeUnsafe(result: CategoryBlurResult): boolean {
  return (
    result.analyzed &&
    result.detected &&
    result.action === "BLUR" &&
    result.score >= CONTENT_BLUR_THRESHOLD
  );
}

function isAnyCategoryUnsafe(outcome: FrameAnalysisOutcome): boolean {
  return (
    isCategoryOutcomeUnsafe(outcome.nudity) ||
    isCategoryOutcomeUnsafe(outcome.violence) ||
    isCategoryOutcomeUnsafe(outcome.kissing)
  );
}

function isOutcomeSafe(outcome: FrameAnalysisOutcome): boolean {
  const results = [outcome.nudity, outcome.violence, outcome.kissing];
  return results.every(
    (result) =>
      !result.analyzed ||
      !result.detected ||
      result.action === "ALLOW" ||
      (result.label === "SFW" && result.score < 0.5)
  );
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
  settings: SafeViewSettings,
  signal?: AbortSignal
): Promise<FrameAnalysisOutcome | null> {
  const categories = getEnabledCategories(settings);

  if (categories.length === 0) {
    return {
      label: "SFW",
      score: 0,
      categories,
      backendTrusted: true,
      animationScore: 0,
      nudity: emptyCategoryResult(),
      violence: emptyCategoryResult(),
      kissing: emptyCategoryResult(),
    };
  }

  let nudity = emptyCategoryResult();
  let violence = emptyCategoryResult();
  let kissing = emptyCategoryResult();
  let animationScore = 0;

  const results = await Promise.all(
    categories.map(async (category) => ({
      category,
      result: await analyzeImage(frame, settings.sensitivity, category, signal),
    }))
  );

  for (const { category, result } of results) {
    if (result === null) {
      return {
        label: "SFW",
        score: 0,
        categories,
        backendTrusted: false,
        animationScore: 0,
        nudity,
        violence,
        kissing,
      };
    }

    if (!result.backendOnline || result.fromFallback) {
      return {
        label: "SFW",
        score: 0,
        categories,
        backendTrusted: false,
        animationScore: 0,
        nudity,
        violence,
        kissing,
      };
    }

    const confidence = result.response.confidence;
    const label = normalizeBlurLabel(result.response.label, confidence);
    const detected = result.response.detected === true;
    const action = normalizeCategoryAction(result.response.action);
    const categoryResult: CategoryBlurResult = {
      analyzed: true,
      detected,
      action,
      score: confidence,
      label,
    };

    if (category === "nudity") {
      nudity = categoryResult;
      animationScore = result.response.animation_score ?? 0;
    } else if (category === "violence") {
      violence = categoryResult;
    } else if (category === "kissing") {
      kissing = categoryResult;
    }
  }

  const analyzed = [nudity, violence, kissing].filter((item) => item.analyzed);
  const maxScore = analyzed.reduce((max, item) => Math.max(max, item.score), 0);
  const label: BlurLabel = analyzed.some((item) => item.label === "NSFW")
    ? "NSFW"
    : "SFW";

  return {
    label,
    score: maxScore,
    categories,
    backendTrusted: true,
    animationScore,
    nudity,
    violence,
    kissing,
  };
}

/**
 * Invalidate in-flight analysis and reset blur decision state for one tab/video.
 *
 * @param tabId - Chrome tab id.
 * @param videoId - Content-script video id.
 */
function resetFramePipelineForVideo(tabId: number, videoId: number): void {
  const key = optimisticStateKey(tabId, videoId);
  const pipeline = framePipelineState.get(key);
  if (!pipeline) {
    return;
  }

  pipeline.abortController?.abort();
  pipeline.generation += 1;
  pipeline.lastUnsafe = false;
  pipeline.lastProcessedFrameSeq = 0;
  pipeline.latestRequestId = 0;
  pipeline.firstDecisionMade = false;
  pipeline.safeStreak = 0;
  pipeline.confirmedUnsafe = false;
  pipeline.unsafeLockUntil = 0;
  pipeline.ignoredUnsafeDriftCount = 0;
  pipeline.captureSession = 0;
  pipeline.pendingSample = null;
  pipeline.analysisInFlight = false;
  pipeline.abortController = null;
}

/**
 * Reset all frame pipelines for a tab (YouTube navigation / new video).
 *
 * @param tabId - Chrome tab id.
 * @returns Video ids that had pipeline state (for CLEAR commands).
 */
function resetFramePipelineForTab(tabId: number): number[] {
  const videoIds: number[] = [];

  for (const key of [...framePipelineState.keys()]) {
    if (!key.startsWith(`${tabId}:`)) {
      continue;
    }

    const videoId = Number(key.split(":")[1]);
    if (!Number.isFinite(videoId)) {
      continue;
    }

    resetFramePipelineForVideo(tabId, videoId);
    videoIds.push(videoId);
  }

  return videoIds;
}

/**
 * Notify the content script that one frame analysis cycle finished.
 */
async function sendFrameAnalysisDone(
  tabId: number,
  videoId: number,
  requestId: number | undefined,
  decision?: string,
  reason?: string,
  meta?: {
    detected?: boolean;
    confidence?: number;
    action?: string;
    capturedVideoTime?: number;
    responseAgeMs?: number;
  }
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: MESSAGE_ACTION_FRAME_ANALYSIS_DONE,
      videoId,
      requestId,
      decision,
      reason,
      ...meta,
    });
  } catch {
    /* Tab may have navigated away. */
  }
}

/** Count of ignored unsafe drift results before warning. */
const IGNORED_UNSAFE_DRIFT_WARN_COUNT = 5;

type TimingRejectReason = "stale" | "time-drift" | "session-mismatch";

/**
 * Validate whether a backend result is fresh enough to apply.
 */
function validateResultTiming(
  message: FrameSampleMessage,
  pipeline: FramePipelineState,
  backendDoneAt: number,
  isUnsafeResult: boolean,
  isSafeResult: boolean
): { accept: boolean; reason?: TimingRejectReason } {
  const capturedAt = message.capturedAt;
  if (capturedAt === undefined) {
    return { accept: true };
  }

  const responseAgeMs = backendDoneAt - capturedAt;
  if (responseAgeMs > STALE_RESPONSE_MS) {
    return { accept: false, reason: "stale" };
  }

  const wallDriftSec = (Date.now() - capturedAt) / 1000;
  if ((isUnsafeResult || isSafeResult) && wallDriftSec > MAX_APPLY_TIME_DRIFT_SEC) {
    return { accept: false, reason: "time-drift" };
  }

  const messageSession = (message as FrameSampleMessage & { captureSession?: number })
    .captureSession;
  if (
    messageSession !== undefined &&
    pipeline.captureSession > 0 &&
    messageSession !== pipeline.captureSession
  ) {
    return { accept: false, reason: "session-mismatch" };
  }

  return { accept: true };
}

function normalizeCategoryAction(action: string | null | undefined): "BLUR" | "ALLOW" | null {
  if (!action) {
    return null;
  }
  const upper = action.toUpperCase();
  if (upper === "BLUR" || upper === "BLOCK" || upper === "UNSAFE" || upper === "BLUR_REGION") {
    return "BLUR";
  }
  return "ALLOW";
}

/**
 * Process one coalesced frame sample (no per-frame abort — latest pending wins).
 *
 * @param message - Frame sample from the content script.
 * @param tabId - Sender tab id.
 * @param pipeline - Mutable pipeline state for this tab/video.
 */
async function processFrameSample(
  message: FrameSampleMessage,
  tabId: number,
  pipeline: FramePipelineState
): Promise<void> {
  const generationAtStart = pipeline.generation;
  const abortController = new AbortController();
  pipeline.abortController = abortController;

  const requestId = message.requestId ?? 0;
  let analysisDecision = "HOLD";
  let analysisReason = "pending";
  let lastDetected: boolean | undefined;
  let lastConfidence: number | undefined;
  let lastNudityAction: string | null | undefined;

  if (requestId > 0 && requestId < pipeline.latestRequestId) {
    return;
  }
  if (requestId > 0) {
    pipeline.latestRequestId = requestId;
  }

  const swReceivedAt = Date.now();
  const settings = getCachedSettings();
  const frame = frameFromMessage(message);
  const frameSeq = message.frameSeq ?? 0;
  const requestLabel = requestId > 0 ? String(requestId) : "?";

  if (message.captureSession !== undefined) {
    pipeline.captureSession = message.captureSession;
  }

  console.info(
    "[SafeView][Pipeline] frame received video=%s session=%s request=%s time=%s",
    message.videoId,
    message.captureSession ?? pipeline.captureSession,
    requestLabel,
    message.capturedAt ?? swReceivedAt
  );
  detailLog(
    "serviceWorker.ts:processFrameSample:entry",
    "frame received",
    {
      tabId,
      videoId: message.videoId,
      requestId,
      frameSeq,
      captureSession: message.captureSession ?? pipeline.captureSession,
      capturedAt: message.capturedAt,
    },
    "H3"
  );

  if (!frame) {
    console.warn("[SafeView] FRAME_SAMPLE ignored — invalid frame buffer.");
  } else if (!settings.protectionEnabled) {
    framePipelineState.delete(optimisticStateKey(tabId, message.videoId));
    await sendBlurCommand(tabId, MESSAGE_ACTION_CLEAR, message.videoId);
  } else {
    try {
      console.info(
        "[SafeView][Pipeline] sending backend categories=%s request=%s",
        getEnabledCategories(settings).join(",") || "none",
        requestLabel
      );

      const inferenceStarted = Date.now();
      const outcome = await analyzeFrameAgainstEnabledCategories(
        frame,
        settings,
        abortController.signal
      );

      if (generationAtStart !== pipeline.generation) {
        return;
      }

      const backendDoneAt = Date.now();
      const inferenceMs = backendDoneAt - inferenceStarted;
      const anyDetected =
        outcome.nudity.detected ||
        outcome.violence.detected ||
        outcome.kissing.detected;
      lastDetected = anyDetected;
      lastConfidence = outcome.score;
      lastNudityAction =
        outcome.nudity.action ??
        outcome.violence.action ??
        outcome.kissing.action ??
        undefined;

      console.info(
        "[SafeView][Pipeline] backend response request=%s nudity=%s/%s violence=%s/%s kissing=%s/%s maxScore=%s",
        requestLabel,
        outcome.nudity.detected,
        outcome.nudity.action ?? "?",
        outcome.violence.detected,
        outcome.violence.action ?? "?",
        outcome.kissing.detected,
        outcome.kissing.action ?? "?",
        outcome.score.toFixed(3)
      );
      detailLog(
        "serviceWorker.ts:processFrameSample:backend",
        "backend response",
        {
          requestId,
          confidence: outcome.score,
          label: outcome.label,
          animationScore: outcome.animationScore,
          backendTrusted: outcome.backendTrusted,
          categories: outcome.categories,
          nudity: outcome.nudity,
          violence: outcome.violence,
          kissing: outcome.kissing,
          inferenceMs,
        },
        "H2"
      );

      const animationScore = outcome.animationScore ?? 0;
      if (animationScore >= ANIMATION_SKIP_THRESHOLD) {
        console.info(
          "[SafeView][Pipeline] decision=ALLOW reason=animation-skip score=%s",
          animationScore.toFixed(2)
        );
        pipeline.confirmedUnsafe = false;
        pipeline.lastUnsafe = false;
        pipeline.safeStreak = 0;
        pipeline.firstDecisionMade = true;
        analysisDecision = "CLEAR";
        analysisReason = "animation-skip";
        detailLog(
          "serviceWorker.ts:processFrameSample:decision",
          "decision=ALLOW reason=animation-skip",
          { requestId, animationScore },
          "H4"
        );
        await sendBlurCommand(tabId, MESSAGE_ACTION_CLEAR, message.videoId, {
          capturedAt: message.capturedAt,
          sentAt: message.sentAt,
          swReceivedAt,
          backendDoneAt,
        });
        return;
      }

      const wouldBeUnsafe = outcome.backendTrusted && isAnyCategoryUnsafe(outcome);

      const wouldBeSafe = outcome.backendTrusted && isOutcomeSafe(outcome);

      const timing = validateResultTiming(
        message,
        pipeline,
        backendDoneAt,
        wouldBeUnsafe,
        wouldBeSafe
      );

      if (!timing.accept && timing.reason) {
        console.info(
          "[SafeView][Pipeline] ignored result reason=%s request=%s",
          timing.reason,
          requestLabel
        );

        if (timing.reason === "time-drift") {
          const capturedAt = message.capturedAt ?? backendDoneAt;
          const driftSec = (Date.now() - capturedAt) / 1000;
          console.info(
            "[SafeView][Timing] ignored delayed result drift=%s request=%s",
            driftSec.toFixed(3),
            requestLabel
          );
          pipeline.ignoredUnsafeDriftCount += 1;
          if (pipeline.ignoredUnsafeDriftCount >= IGNORED_UNSAFE_DRIFT_WARN_COUNT) {
            console.warn(
              "[SafeView][Timing] too many unsafe results ignored — drift threshold may be too strict"
            );
            pipeline.ignoredUnsafeDriftCount = 0;
          }
        }

        analysisDecision = "HOLD";
        analysisReason = timing.reason;
        detailLog(
          "serviceWorker.ts:processFrameSample:timing",
          "ignored result",
          { requestId, reason: timing.reason, wouldBeUnsafe },
          "H5"
        );
        return;
      }

      const evaluation = evaluateBlurState({
        label: outcome.label,
        score: outcome.score,
        frameSeq,
        lastProcessedFrameSeq: pipeline.lastProcessedFrameSeq,
        resultGeneration: generationAtStart,
        currentGeneration: pipeline.generation,
        backendTrusted: outcome.backendTrusted,
        firstDecisionMade: pipeline.firstDecisionMade,
        safeStreak: pipeline.safeStreak,
        confirmedUnsafe: pipeline.confirmedUnsafe,
        nudity: outcome.nudity,
        violence: outcome.violence,
        kissing: outcome.kissing,
      });

      logBlurEvaluation(evaluation, {
        label: outcome.label,
        score: outcome.score,
        frame: frameSeq,
        gen: generationAtStart,
        currentGen: pipeline.generation,
        detected: anyDetected,
        action: lastNudityAction ?? null,
      });

      analysisDecision = evaluation.action;
      analysisReason = evaluation.reason;

      const trace = {
        capturedAt: message.capturedAt,
        sentAt: message.sentAt,
        swReceivedAt,
        backendDoneAt,
        capturedVideoTime: message.capturedVideoTime,
      };

      if (evaluation.action === "DROP") {
        return;
      }

      if (evaluation.action === "HOLD") {
        if (evaluation.reason === "building_safe_streak") {
          pipeline.safeStreak += 1;
        }
        if (
          pipeline.confirmedUnsafe &&
          evaluation.reason === "holding_confirmed_unsafe"
        ) {
          await sendBlurCommand(tabId, MESSAGE_ACTION_BLUR, message.videoId, trace);
        }
        return;
      }

      pipeline.firstDecisionMade = true;
      pipeline.lastProcessedFrameSeq = frameSeq;

      const extensionVersion = chrome.runtime.getManifest().version;
      const contentBuild = message.contentBuild ?? "unknown";
      const contentStale = contentBuild !== extensionVersion;

      if (contentStale && evaluation.action === "BLUR") {
        console.warn(
          "[SafeView] Tab content script is stale (content %s, extension %s). Reload the YouTube tab after updating the extension.",
          contentBuild,
          extensionVersion
        );
      }

      if (evaluation.action === "BLUR") {
        pipeline.lastUnsafe = true;
        pipeline.confirmedUnsafe = true;
        pipeline.unsafeLockUntil = Date.now() + MIN_CONFIRMED_UNSAFE_HOLD_MS;
        pipeline.safeStreak = 0;
        pipeline.ignoredUnsafeDriftCount = 0;
        logPipelineLatency(
          tabId,
          message.videoId,
          message,
          swReceivedAt,
          backendDoneAt,
          MESSAGE_ACTION_BLUR,
          inferenceMs
        );
        console.info("[SafeView][Blur] apply confirmed unsafe");
        detailLog(
          "serviceWorker.ts:processFrameSample:blur",
          "BLUR command sent",
          { tabId, videoId: message.videoId, requestId, inferenceMs },
          "H4"
        );
        await sendBlurCommand(tabId, MESSAGE_ACTION_BLUR, message.videoId, trace);
      } else if (evaluation.action === "CLEAR") {
        if (pipeline.confirmedUnsafe && Date.now() < pipeline.unsafeLockUntil) {
          analysisDecision = "HOLD";
          analysisReason = "unsafe_hold";
          await sendBlurCommand(tabId, MESSAGE_ACTION_BLUR, message.videoId, trace);
          return;
        }

        pipeline.lastUnsafe = false;
        pipeline.confirmedUnsafe = false;
        pipeline.safeStreak = 0;
        logPipelineLatency(
          tabId,
          message.videoId,
          message,
          swReceivedAt,
          backendDoneAt,
          MESSAGE_ACTION_CLEAR,
          inferenceMs
        );
        console.info("[SafeView][Blur] clear confirmed safe");
        await sendBlurCommand(tabId, MESSAGE_ACTION_CLEAR, message.videoId, trace);
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      console.error("[SafeView] Frame handling failed — no blur change:", error);

      if (generationAtStart !== pipeline.generation) {
        return;
      }

      analysisDecision = "HOLD";
      analysisReason = "backend_error";
    } finally {
      if (pipeline.abortController === abortController) {
        pipeline.abortController = null;
      }
    }
  }

  const responseAgeMs =
    message.capturedAt !== undefined ? Date.now() - message.capturedAt : 0;

  await sendFrameAnalysisDone(
    tabId,
    message.videoId,
    requestId,
    analysisDecision,
    analysisReason,
    {
      detected: lastDetected,
      confidence: lastConfidence,
      action: lastNudityAction ?? undefined,
      capturedVideoTime: message.capturedVideoTime,
      responseAgeMs,
    }
  );
}

/**
 * Handle one FRAME_SAMPLE message: backend inference then BLUR/CLEAR (push via tabs.sendMessage).
 *
 * @param message - Frame sample from the content script.
 * @param tabId - Sender tab id captured before the runtime message channel closes.
 */
export async function handleFrameSample(
  message: FrameSampleMessage,
  tabId: number
): Promise<void> {
  const pipeline = getFramePipelineState(tabId, message.videoId);
  pipeline.pendingSample = message;

  if (pipeline.analysisInFlight) {
    return;
  }

  pipeline.analysisInFlight = true;

  try {
    while (pipeline.pendingSample) {
      const latest = pipeline.pendingSample;
      pipeline.pendingSample = null;
      await processFrameSample(latest, tabId, pipeline);
    }
  } finally {
    pipeline.analysisInFlight = false;

    if (pipeline.pendingSample) {
      void handleFrameSample(pipeline.pendingSample, tabId);
    }
  }
}

/**
 * Reset blur pipeline and send CLEAR after YouTube navigation / new video.
 *
 * @param tabId - Chrome tab id.
 * @param reason - Diagnostic label.
 */
export async function resetBlurPipelineOnNavigation(
  tabId: number,
  reason: string
): Promise<void> {
  const videoIds = resetFramePipelineForTab(tabId);

  await Promise.all(
    videoIds.map((videoId) =>
      sendBlurCommand(tabId, MESSAGE_ACTION_CLEAR, videoId)
    )
  );

  console.info(
    "[SafeView] NEW VIDEO detected — pipeline reset (%s) tab=%s videos=%s",
    reason,
    tabId,
    videoIds.length
  );
}

/**
 * Rebuild a WebM Blob from the content script's base64 audio payload.
 *
 * @param message - AUDIO_CHUNK message from the content script.
 * @returns Blob for /analyze-audio, or null when bytes are missing.
 */
function audioFromMessage(message: AudioChunkMessage): Blob | null {
  if (
    typeof message.audioBase64 !== "string" ||
    message.audioBase64.length === 0
  ) {
    return null;
  }

  return base64ToBlob(message.audioBase64, "audio/webm");
}

/**
 * Offscreen delay-pipeline chunk for Whisper + profanity (tab capture scout path).
 */
export interface PipelineAudioChunkMessage {
  action: typeof MESSAGE_ACTION_AUDIO_CHUNK_PIPELINE;
  audioBase64?: string;
  payload?: string;
  capturedAt: number;
  tabId: number;
}

/**
 * Resolve base64 audio from offscreen pipeline messages (audioBase64 or payload).
 */
function resolvePipelineAudioBase64(
  message: PipelineAudioChunkMessage
): string | null {
  if (
    typeof message.audioBase64 === "string" &&
    message.audioBase64.length > 0
  ) {
    return message.audioBase64;
  }

  if (typeof message.payload === "string" && message.payload.length > 0) {
    return message.payload;
  }

  return null;
}

/**
 * Handle AUDIO_CHUNK_PIPELINE from the offscreen document (separate from content AUDIO_CHUNK).
 *
 * @param message - Scout chunk with base64 WebM audio.
 * @param tabId - Tab that owns the capture pipeline.
 */
export async function handlePipelineAudioChunk(
  message: PipelineAudioChunkMessage,
  tabId: number
): Promise<void> {
  const current = audioProcessingCount.get(tabId) ?? 0;
  if (current >= MAX_CONCURRENT_AUDIO) {
    return;
  }

  audioProcessingCount.set(tabId, current + 1);

  console.info("[SafeView] AUDIO_CHUNK_PIPELINE processing — tab=%s", tabId);

  try {
    const audioBase64 = resolvePipelineAudioBase64(message);
    if (!audioBase64) {
      console.warn("[SafeView] AUDIO_CHUNK_PIPELINE missing audio payload.");
      return;
    }

    const audio = base64ToBlob(audioBase64, "audio/webm");
    if (!audio) {
      return;
    }

    const result = await analyzeAudio(
      audio,
      "en" // pipeline always english — subtitle path handles language switching
    );

    console.info(
      "[SafeView][Audio-5] Backend response: detected=%s, confidence=%s, action=%s, whisper_loaded=%s",
      result.response.detected,
      result.response.confidence,
      result.response.action,
      result.response.whisper_loaded
    );

    if (
      result.backendOnline &&
      !result.fromFallback &&
      result.response.detected
    ) {
      console.info(
        "[SafeView][Audio-6] Profanity confirmed — sending ELEMENT_MUTE_GAIN"
      );
      console.info(
        "[SafeView] Profanity detected in pipeline — triggering gain mute"
      );
      await sendPipelineMuteGain(MUTE_DURATION_MS);
    }
  } catch (error) {
    console.error("[SafeView] Pipeline audio chunk handling failed:", error);
  } finally {
    const inFlight = audioProcessingCount.get(tabId) ?? 1;
    audioProcessingCount.set(tabId, Math.max(0, inFlight - 1));
  }
}

/**
 * Handle one AUDIO_CHUNK message: transcribe + profanity, then push MUTE when detected.
 *
 * @param message - Audio chunk from the content script.
 * @param tabId - Sender tab id captured before the runtime message channel closes.
 */
export async function handleAudioChunk(
  message: AudioChunkMessage,
  tabId: number
): Promise<void> {
  const settings = await loadSettings();

  if (!settings.protectionEnabled || !settings.categories.profanity) {
    return;
  }

  const audio = audioFromMessage(message);

  if (!audio) {
    console.warn("[SafeView] AUDIO_CHUNK ignored — invalid audio buffer.");
    return;
  }

  const language = message.language === "am" ? "am" : "en";

  try {
    const result = await analyzeAudio(audio, language, settings.sensitivity);

    if (
      !result.backendOnline ||
      result.fromFallback ||
      !result.response.detected
    ) {
      return;
    }

    const durationMs =
      result.response.duration_ms > 0
        ? result.response.duration_ms
        : MUTE_DURATION_MS;

    console.info("[SafeView] Profanity detected — sending MUTE to tab.");
    await sendMuteCommand(tabId, message.videoId, durationMs);
  } catch (error) {
    console.error("[SafeView] Audio chunk handling failed — failing open:", error);
  }
}

/**
 * Stop only the offscreen graph (keep document open for quick restart).
 */
async function stopOffscreenPipelineOnly(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      action: MESSAGE_ACTION_STOP_AUDIO_PIPELINE,
    });
  } catch {
    /* Offscreen may already be stopped. */
  }
}

/**
 * Fall back to content-script MediaElementAudioSource when tabCapture is unusable.
 *
 * @param tabId - Tab to run the element graph in.
 * @param reason - Diagnostic label for logs.
 * @returns True when the fallback message was dispatched.
 */
async function sendWithRetry(
  tabId: number,
  message: object,
  maxAttempts = 5,
  delayMs = 500
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch (e) {
      if (attempt === maxAttempts) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function triggerElementAudioFallback(
  tabId: number,
  reason: string
): Promise<boolean> {
  try {
    await sendWithRetry(tabId, {
      action: MESSAGE_ACTION_RESET_PIPELINE_GAIN,
    });
    await sendWithRetry(tabId, {
      action: MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK,
      tabId,
    });
    audioPipelineMode = "element";
    activeAudioPipelineTabId = tabId;
    console.info("[SafeView] Element audio pipeline rebound (%s).", reason);
    return true;
  } catch (error) {
    console.warn("[SafeView] Element audio fallback failed:", error);
    return false;
  }
}

/**
 * Reset offscreen + content gain to 1.0 after navigation or watch-id change.
 *
 * @param reason - Diagnostic label for logs.
 */
async function resetPipelineGainsForActiveTab(reason: string): Promise<void> {
  const tabId = activeAudioPipelineTabId;

  try {
    await chrome.runtime.sendMessage({
      action: MESSAGE_ACTION_RESET_PIPELINE_GAIN,
    });
  } catch {
    /* Offscreen may be stopped. */
  }

  if (tabId !== undefined) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: MESSAGE_ACTION_RESET_PIPELINE_GAIN,
      });
    } catch {
      /* Content script may not be ready. */
    }

    if (audioPipelineMode === "element") {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK,
          tabId,
        });
      } catch {
        /* Rebind failed; element graph may recover on next navigation. */
      }
    }
  }

  console.info("[SafeView] Pipeline gain reset (%s).", reason);
}

/**
 * Route profanity mute to the active audio path (offscreen or element).
 *
 * @param durationMs - BR-05 mute duration.
 */
async function sendPipelineMuteGain(durationMs: number): Promise<void> {
  if (activeAudioPipelineTabId !== undefined) {
    try {
      await chrome.tabs.sendMessage(activeAudioPipelineTabId, {
        action: MESSAGE_ACTION_ELEMENT_MUTE_GAIN,
        duration: durationMs,
        duration_ms: durationMs,
      });
    } catch (error) {
      console.warn("[SafeView] Could not deliver ELEMENT_MUTE_GAIN:", error);
    }
    return;
  }

  await sendMuteGainToOffscreen(durationMs);
}

/**
 * Start element audio pipeline in the content script (primary path for demo).
 *
 * @param tabId - Chrome tab running the YouTube page.
 */
export async function startAudioPipelineWithStream(
  tabId: number,
  _streamId?: string
): Promise<void> {
  await startAudioPipeline(tabId);
}

/**
 * Start element audio pipeline in the content script (primary path for demo).
 *
 * @param tabId - Chrome tab to route audio from.
 */
export async function startAudioPipeline(tabId: number): Promise<void> {
  try {
    await sendWithRetry(tabId, {
      action: MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK,
      tabId,
    });
    audioPipelineMode = "element";
    activeAudioPipelineTabId = tabId;
    console.info("[SafeView] Element audio pipeline started for tab %s.", tabId);
  } catch (error) {
    console.error("[SafeView] Failed to start audio pipeline:", error);
  }
}

/**
 * Stop tab-capture audio pipeline and close the offscreen document when open.
 *
 * @param reason - Diagnostic label for why the pipeline is stopping.
 */
export async function stopAudioPipeline(reason = "unknown"): Promise<void> {
  console.info("[SafeView] stopAudioPipeline called — reason: %s", reason);

  const pipelineTabId = activeAudioPipelineTabId;

  if (pipelineTabId !== undefined) {
    try {
      await chrome.tabs.sendMessage(pipelineTabId, {
        action: MESSAGE_ACTION_STOP_ELEMENT_AUDIO_FALLBACK,
      });
    } catch {
      /* Tab may have closed. */
    }
  }

  activeAudioPipelineTabId = undefined;
  audioPipelineMode = null;
}

/**
 * Push MUTE_GAIN to the offscreen document with exact BR-05 mute duration.
 *
 * @param durationMs - Mute hold in milliseconds (default 1500).
 */
async function sendMuteGainToOffscreen(
  durationMs: number = MUTE_DURATION_MS
): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      action: MESSAGE_ACTION_MUTE_GAIN,
      duration: durationMs,
      duration_ms: durationMs,
    });
  } catch (error) {
    console.warn("[SafeView] Could not deliver MUTE_GAIN to offscreen:", error);
  }
}

/**
 * Read whether protection is enabled from storage (BR-04).
 */
async function getProtectionState(): Promise<boolean> {
  const settings = await loadSettings();
  return settings.protectionEnabled;
}

/**
 * Restart the offscreen audio pipeline when the user switches tabs.
 */
function setupPipelineTabNavigationListener(): void {
  if (typeof process !== "undefined" && process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== activeAudioPipelineTabId || !changeInfo.url) {
      return;
    }

    void resetPipelineGainsForActiveTab("tab-url-change").catch((error) => {
      console.warn("[SafeView] Tab URL gain reset failed:", error);
    });
  });
}

function setupTabActivationListener(): void {
  if (typeof process !== "undefined" && process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  chrome.tabs.onActivated.addListener((activeInfo) => {
    void (async () => {
      const isProtectionOn = await getProtectionState();
      if (!isProtectionOn) {
        return;
      }

      if (activeInfo.tabId === activeAudioPipelineTabId) {
        return;
      }

      console.info('[SafeView] Tab switched — user must re-enable protection from popup for audio pipeline on new tab.');
    })().catch((error) => {
      console.error("[SafeView] Tab activation handler failed:", error);
    });
  });
}

/**
 * Forward SETTINGS_UPDATED to a tab content script.
 */
async function forwardSettingsUpdatedToTab(
  tabId: number,
  reason: string
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: MESSAGE_ACTION_SETTINGS_UPDATED,
      reason,
    });
  } catch {
    console.info(
      "[SafeView] Could not forward SETTINGS_UPDATED to tab %s",
      tabId
    );
  }
}

/**
 * Reset all frame pipelines and send CLEAR (protection/nudity turned off).
 */
async function clearAllFramePipelinesAndBlur(): Promise<void> {
  for (const key of [...framePipelineState.keys()]) {
    const [tabIdPart, videoIdPart] = key.split(":");
    const tabId = Number(tabIdPart);
    const videoId = Number(videoIdPart);

    if (!Number.isFinite(tabId) || !Number.isFinite(videoId)) {
      continue;
    }

    resetFramePipelineForVideo(tabId, videoId);
    await sendBlurCommand(tabId, MESSAGE_ACTION_CLEAR, videoId);
  }
}

/**
 * Reload settings and sync active tab / pipelines after a settings change.
 */
async function handleSettingsUpdated(
  reason: string,
  senderTabId?: number
): Promise<void> {
  await loadSettings();
  const settings = getCachedSettings();

  console.info(
    "[SafeView] SETTINGS_UPDATED (%s) protection=%s nudity=%s enabled=%s",
    reason,
    settings.protectionEnabled,
    settings.categories.nudity,
    getEnabledCategories(settings).join(",") || "none"
  );

  if (!isNudityProtectionActive(settings)) {
    await clearAllFramePipelinesAndBlur();

    if (!settings.protectionEnabled) {
      void stopAudioPipeline("protection-off");
    }
  }

  let tabId = senderTabId;
  if (tabId === undefined) {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    tabId = tab?.id;
  }

  if (tabId !== undefined) {
    await forwardSettingsUpdatedToTab(tabId, reason);
  }
}

/**
 * React to settings changes persisted from popup/options (BR-04).
 */
function setupProtectionToggleListener(): void {
  if (typeof process !== "undefined" && process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const settingsChange = changes[SETTINGS_STORAGE_KEY];
    if (settingsChange === undefined) {
      return;
    }

    void handleSettingsUpdated("storage").catch((error) => {
      console.error("[SafeView] Settings storage handler failed:", error);
    });
  });
}

/**
 * Route runtime messages from content scripts (ack immediately; push actions via tabs.sendMessage).
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.action === MESSAGE_ACTION_SETTINGS_UPDATED) {
    const reason =
      typeof message.reason === "string" ? message.reason : "unknown";

    sendResponse({ received: true });
    void handleSettingsUpdated(reason, sender.tab?.id).catch((error) => {
      console.error("[SafeView] SETTINGS_UPDATED handler failed:", error);
    });

    return false;
  }

  if (message.action === MESSAGE_ACTION_FRAME_SAMPLE) {
    const tabId = sender.tab?.id;
    const frameMessage = message as FrameSampleMessage;

    const payloadLen = Array.isArray(frameMessage.framePayload)
      ? frameMessage.framePayload.length
      : 0;
    const normalized = getFrameBytesFromMessage(frameMessage);
    const hasFrameBytes = hasDecodableFrameBytes(frameMessage);

    if (typeof frameMessage.videoId !== "number" || !hasFrameBytes) {
      console.warn(
        "[SafeView] Invalid FRAME_SAMPLE payload (payloadLen=%s).",
        payloadLen
      );
      sendResponse({ received: false });
      return false;
    }

    sendResponse({ received: true });
    console.info(
      "[SafeView] FRAME_SAMPLE received — tab=%s video=%s payloadLen=%s normalized=%s",
      tabId ?? "?",
      frameMessage.videoId,
      payloadLen,
      normalized?.byteLength ?? 0
    );
    if (tabId !== undefined) {
      void handleFrameSample(frameMessage, tabId).catch((error) => {
        console.error("[SafeView] FRAME_SAMPLE handler error:", error);
      });
    }

    return false;
  }

  if (message.action === MESSAGE_ACTION_AUDIO_CHUNK) {
    const tabId = sender.tab?.id;
    const audioMessage = message as AudioChunkMessage;

    if (
      typeof audioMessage.videoId !== "number" ||
      typeof audioMessage.audioBase64 !== "string" ||
      audioMessage.audioBase64.length === 0
    ) {
      console.warn("[SafeView] Invalid AUDIO_CHUNK payload.");
      sendResponse({ received: false });
      return false;
    }

    sendResponse({ received: true });
    if (tabId !== undefined) {
      void handleAudioChunk(audioMessage, tabId).catch((error) => {
        console.error("[SafeView] AUDIO_CHUNK handler error:", error);
      });
    }

    return false;
  }

  if (message.action === MESSAGE_ACTION_PROFANITY_DETECTED) {
    const durationMs =
      typeof message.duration_ms === "number" && message.duration_ms > 0
        ? message.duration_ms
        : MUTE_DURATION_MS;

    sendResponse({ received: true });
    void sendPipelineMuteGain(durationMs);
    return false;
  }

  if (message.action === MESSAGE_ACTION_TAB_CAPTURE_INIT_FAILED) {
    sendResponse({ received: true });
    const failMessage = message as { error?: string };
    console.error(
      "[SafeView] TAB_CAPTURE_INIT_FAILED received, error=%s",
      failMessage.error ?? "(none)"
    );
    return false;
  }

  if (message.action === MESSAGE_ACTION_PIPELINE_NAVIGATION) {
    const navTabId = sender.tab?.id;
    const navReason =
      typeof message.reason === "string" ? message.reason : "pipeline-navigation";

    sendResponse({ received: true });

    if (navTabId !== undefined) {
      void resetBlurPipelineOnNavigation(navTabId, navReason).catch((error) => {
        console.warn("[SafeView] Navigation blur reset failed:", error);
      });
    }

    void resetPipelineGainsForActiveTab(navReason);
    return false;
  }

  if (message.action === MESSAGE_ACTION_TAB_CAPTURE_SILENT_STREAM) {
    const tabId = message.tabId;
    sendResponse({ received: true });
    if (typeof tabId === "number") {
      console.warn(
        "[SafeView] Tab capture stream reported silent (tab %s) — keeping offscreen pipeline running.",
        tabId
      );
    }
    return false;
  }

  if (message.action === MESSAGE_ACTION_AUDIO_CHUNK_PIPELINE) {
    const tabId = (message as PipelineAudioChunkMessage).tabId;
    const pipelineMessage = message as PipelineAudioChunkMessage;

    sendResponse({ received: true });
    console.info(
      "[SafeView][Audio-4] SW received pipeline chunk, tabId=%s, base64Len=%s",
      tabId,
      resolvePipelineAudioBase64(pipelineMessage)?.length ?? 0
    );
    console.info(
      "[SafeView] AUDIO_CHUNK_PIPELINE received — tab=%s",
      tabId ?? "?"
    );

    if (typeof tabId === "number") {
      void handlePipelineAudioChunk(
        message as PipelineAudioChunkMessage,
        tabId
      ).catch((error) => {
        console.error("[SafeView] AUDIO_CHUNK_PIPELINE handler error:", error);
      });
    }

    return false;
  }

  if (message.action === MESSAGE_ACTION_START_PIPELINE_WITH_STREAM) {
    const tabId = message.tabId;

    if (typeof tabId !== "number") {
      console.warn("[SafeView] Invalid START_PIPELINE_WITH_STREAM payload.");
      sendResponse({ success: false, error: "Invalid payload" });
      return false;
    }

    void (async () => {
      try {
        await startAudioPipeline(tabId);
        sendResponse({ success: true });
      } catch (error) {
        console.error(
          "[SafeView] Error starting audio pipeline:",
          error
        );
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  }

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
void initSettingsCache();
startServiceWorkerKeepalive();
setupProtectionToggleListener();
setupTabActivationListener();
setupPipelineTabNavigationListener();

console.info(
  "[SafeView] Service worker loaded (v%s, label-gated blur).",
  chrome.runtime.getManifest().version
);
