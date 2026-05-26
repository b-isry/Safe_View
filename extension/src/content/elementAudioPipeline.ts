// SafeView — elementAudioPipeline.ts
// Singleton Web Audio graph for YouTube — one MediaElementSource per <video>, shared gain + recorder tap.

import {
  loadSettings,
  PROFANITY_MUTE_DURATION_MS,
  SETTINGS_STORAGE_KEY,
} from "../background/businessRules";
import {
  isProfanityProtectionActive,
  MESSAGE_ACTION_SETTINGS_UPDATED,
} from "../shared/settingsMessages";
import { showBeepTriggeredNotification } from "./beepNotification";
import { clearReactiveProfanityMute, triggerWebBeep } from "./profanityReactive";
import {
  findPrimaryVisibleVideo,
  hardStopVisionCaptureForAudioPriority,
  rescanVideosForTargeting,
  stopAllSampling,
  waitForVideoDiscovery,
} from "./videoMonitor";

/** Service worker → content: start native video element audio graph. */
export const MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK =
  "START_ELEMENT_AUDIO_FALLBACK";

/** Alias used by the service worker bridge. */
export const MESSAGE_ACTION_START_AUDIO_PIPELINE = "START_AUDIO_PIPELINE";

/** Service worker → content: tear down element audio graph. */
export const MESSAGE_ACTION_STOP_ELEMENT_AUDIO_FALLBACK =
  "STOP_ELEMENT_AUDIO_FALLBACK";

/** Service worker → content: mute element-path gain node (BR-05). */
export const MESSAGE_ACTION_ELEMENT_MUTE_GAIN = "ELEMENT_MUTE_GAIN";

/** Service worker → content: force element-path gain back to 1.0. */
export const MESSAGE_ACTION_RESET_PIPELINE_GAIN = "RESET_PIPELINE_GAIN";

/** Content → service worker: scout chunk for /analyze-audio. */
const MESSAGE_ACTION_AUDIO_CHUNK_PIPELINE = "AUDIO_CHUNK_PIPELINE";

const AUDIO_WEBM_OPUS_MIME = "audio/webm;codecs=opus";
const SCOUT_CHUNK_MS = 3000;
/** Whisper needs real audio — ignore WebM header-only blobs (~254 bytes). */
const MIN_BLOB_BYTES = 10000;
const MUTE_HOLD_MS = PROFANITY_MUTE_DURATION_MS;
const RECORDER_START_DELAY_MS = 500;
const AUDIO_PIPELINE_RETRY_MS = 1000;
const MAX_AUDIO_PIPELINE_RETRIES = 5;
const VIDEO_WAIT_ATTEMPTS = 10;
const HAVE_FUTURE_DATA = 3;

/** Matches videoMonitor.ts SAFE_VIEW_TRACKED_DATASET (data-safe-view-tracked). */
const SAFE_VIEW_TRACKED_DATASET = "safeViewTracked";

/** Per-video singleton graph (survives YouTube SPA navigation). */
interface VideoAudioSingleton {
  context: AudioContext;
  sourceNode: MediaElementAudioSourceNode;
  singletonGain: GainNode;
  streamDestination: MediaStreamAudioDestinationNode;
}

const initializedSources = new WeakMap<HTMLVideoElement, VideoAudioSingleton>();

let pipelineTabId: number | undefined;
let audioContext: AudioContext | null = null;
let singletonGain: GainNode | null = null;
let mediaElementSource: MediaElementAudioSourceNode | null = null;
let boundVideo: HTMLVideoElement | null = null;
let streamDestination: MediaStreamAudioDestinationNode | null = null;
let scoutRecorder: MediaRecorder | null = null;
let scoutChunkStopIntervalId: ReturnType<typeof setInterval> | null = null;
let audioStartRetryTimeoutId: ReturnType<typeof setTimeout> | null = null;
let singletonMuteRestoreTimeoutId: ReturnType<typeof setTimeout> | null = null;

function syncModuleRefs(graph: VideoAudioSingleton, video: HTMLVideoElement): void {
  audioContext = graph.context;
  mediaElementSource = graph.sourceNode;
  singletonGain = graph.singletonGain;
  streamDestination = graph.streamDestination;
  boundVideo = video;
}

function isYouTubeHost(): boolean {
  const host = window.location.hostname.toLowerCase();
  return (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host.endsWith(".youtube.com")
  );
}

function shouldSkipCaptureStream(): boolean {
  return isYouTubeHost();
}

function toAudioOnlyStream(stream: MediaStream): MediaStream {
  const audioTracks = stream.getAudioTracks();
  if (stream.getVideoTracks().length === 0) {
    return stream;
  }
  return new MediaStream(audioTracks);
}

export function prepareVideoCrossOrigin(video: HTMLVideoElement): void {
  if (!isYouTubeHost() && video.crossOrigin !== "anonymous") {
    video.crossOrigin = "anonymous";
  }
}

/**
 * Wire source → singletonGain → speakers AND recorder (never bypass gain for recorder).
 */
function wireSingletonGraph(graph: VideoAudioSingleton): void {
  try {
    graph.sourceNode.disconnect();
  } catch {
    /* Not connected yet. */
  }

  try {
    graph.singletonGain.disconnect();
  } catch {
    /* Not connected yet. */
  }

  graph.sourceNode.connect(graph.singletonGain);
  graph.singletonGain.connect(graph.context.destination);
  graph.singletonGain.connect(graph.streamDestination);
}

/**
 * Get or create the singleton Web Audio graph for this video (no rebind on navigation).
 */
function getOrCreateSingletonGraph(
  video: HTMLVideoElement
): VideoAudioSingleton | null {
  const existing = initializedSources.get(video);
  if (existing && existing.context.state !== "closed") {
    wireSingletonGraph(existing);
    syncModuleRefs(existing, video);
    return existing;
  }

  try {
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext();
    }

    const context = audioContext;
    const sourceNode = context.createMediaElementSource(video);
    const gain = context.createGain();
    gain.gain.setValueAtTime(1, context.currentTime);
    const destination = context.createMediaStreamDestination();

    const graph: VideoAudioSingleton = {
      context,
      sourceNode,
      singletonGain: gain,
      streamDestination: destination,
    };

    wireSingletonGraph(graph);
    initializedSources.set(video, graph);
    syncModuleRefs(graph, video);

    console.info("[SafeView] Singleton audio graph created for video element.");
    return graph;
  } catch (error) {
    const cached = initializedSources.get(video);
    if (cached) {
      console.info("[SafeView] Reusing cached singleton graph after create error.");
      wireSingletonGraph(cached);
      syncModuleRefs(cached, video);
      return cached;
    }

    console.error("[SafeView] Singleton audio graph failed:", error);
    return null;
  }
}

/**
 * Mute playback + recorder tap via singleton gain; play reactive beep (BR-05).
 */
export function applySingletonProfanityMute(
  durationMs: number = MUTE_HOLD_MS
): void {
  const video = boundVideo ?? findPrimaryVisibleVideo();
  const graph = video ? initializedSources.get(video) : undefined;
  const gain = graph?.singletonGain ?? singletonGain;

  if (gain) {
    const ctx = gain.context;
    const now = ctx.currentTime;
    const holdSeconds = durationMs / 1000;

    if (singletonMuteRestoreTimeoutId !== null) {
      clearTimeout(singletonMuteRestoreTimeoutId);
      singletonMuteRestoreTimeoutId = null;
    }

    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.setValueAtTime(1, now + holdSeconds);

    singletonMuteRestoreTimeoutId = window.setTimeout(() => {
      singletonMuteRestoreTimeoutId = null;
      const restoreNow = gain.context.currentTime;
      gain.gain.cancelScheduledValues(restoreNow);
      gain.gain.setValueAtTime(1, restoreNow);
    }, durationMs);

    console.info(
      "[SafeView] Singleton gain mute (0) for %sms — audio_action BEEP/MUTE",
      durationMs
    );
  }

  if (video) {
    console.log("!!! TRIGGERING BEEP NOW !!!");
    triggerWebBeep(video, durationMs);
  }
}

export function resetElementPipelineGain(): void {
  const video = boundVideo ?? findPrimaryVisibleVideo();
  const graph = video ? initializedSources.get(video) : undefined;
  const gain = graph?.singletonGain ?? singletonGain;

  if (!gain) {
    return;
  }

  const now = gain.context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(1, now);
}

function resolveRecorderMimeType(): string | null {
  const candidates = [
    AUDIO_WEBM_OPUS_MIME,
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];

  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }

  return null;
}

function stopScoutRecorderLoop(): void {
  if (scoutChunkStopIntervalId !== null) {
    clearInterval(scoutChunkStopIntervalId);
    scoutChunkStopIntervalId = null;
  }
}

function stopScoutRecorder(): void {
  stopScoutRecorderLoop();

  if (!scoutRecorder) {
    return;
  }

  if (scoutRecorder.state === "recording") {
    try {
      scoutRecorder.stop();
    } catch {
      /* Already stopped. */
    }
  }

  scoutRecorder = null;
}

async function waitForRecorderPrerequisites(
  video: HTMLVideoElement,
  context: AudioContext | null
): Promise<boolean> {
  if (video.readyState < HAVE_FUTURE_DATA) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("canplay", done);
        resolve();
      };

      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("canplay", done, { once: true });
      window.setTimeout(done, 4000);
    });
  }

  if (video.readyState < HAVE_FUTURE_DATA) {
    console.warn(
      "[SafeView] Scout recorder — video.readyState=%s (need >= %s)",
      video.readyState,
      HAVE_FUTURE_DATA
    );
    return false;
  }

  if (video.paused) {
    try {
      await video.play();
    } catch {
      console.warn("[SafeView] Scout recorder — video.play() blocked (user gesture?).");
    }
  }

  if (context) {
    if (context.state !== "running") {
      await context.resume();
    }

    if (context.state !== "running") {
      console.warn(
        "[SafeView] Scout recorder — AudioContext state=%s (need running)",
        context.state
      );
      return false;
    }
  }

  await new Promise((resolve) => {
    window.setTimeout(resolve, RECORDER_START_DELAY_MS);
  });

  return true;
}

function attachScoutRecorderHandlers(recorder: MediaRecorder, tabId: number): void {
  recorder.ondataavailable = (event: BlobEvent) => {
    const chunkSize = event.data?.size ?? 0;
    console.log("[SafeView-DATA] Captured Audio: " + chunkSize + " bytes");

    if (!event.data || chunkSize < MIN_BLOB_BYTES) {
      return;
    }

    console.log("[SafeView-FLOW] Forwarding to Backend via Service Worker");

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        return;
      }

      const base64 = reader.result.split(",")[1];
      if (!base64) {
        return;
      }

      void chrome.runtime
        .sendMessage({
          action: MESSAGE_ACTION_AUDIO_CHUNK_PIPELINE,
          payload: base64,
          tabId,
        })
        .catch(() => {});
    };
    reader.readAsDataURL(event.data);
  };

  recorder.onerror = (event: Event) => {
    console.error("[SafeView] MediaRecorder error:", event);
  };
}

function tryStartMediaRecorder(
  stream: MediaStream,
  mimeType: string | undefined,
  timesliceMs: number
): MediaRecorder | null {
  const attempts: Array<{ mime?: string; timeslice: number }> = [
    { mime: mimeType ?? undefined, timeslice: timesliceMs },
    { mime: undefined, timeslice: timesliceMs },
  ];

  for (const attempt of attempts) {
    try {
      const recorder = attempt.mime
        ? new MediaRecorder(stream, { mimeType: attempt.mime })
        : new MediaRecorder(stream);

      recorder.start(attempt.timeslice);
      return recorder;
    } catch {
      /* Try next combination. */
    }
  }

  return null;
}

async function startScoutRecorder(
  stream: MediaStream,
  tabId: number,
  video: HTMLVideoElement,
  context: AudioContext | null
): Promise<boolean> {
  stopScoutRecorder();

  const audioOnly = toAudioOnlyStream(stream);
  const audioTracks = audioOnly.getAudioTracks();
  if (audioTracks.length === 0) {
    console.warn("[SafeView] Scout recorder — stream has no audio tracks.");
    return false;
  }

  const ready = await waitForRecorderPrerequisites(video, context);
  if (!ready) {
    return false;
  }

  const mimeType = resolveRecorderMimeType();
  scoutRecorder = tryStartMediaRecorder(
    audioOnly,
    mimeType ?? undefined,
    SCOUT_CHUNK_MS
  );

  if (!scoutRecorder) {
    console.error("[SafeView] scoutRecorder.start() failed after MIME attempts.");
    scoutRecorder = null;
    return false;
  }

  attachScoutRecorderHandlers(scoutRecorder, tabId);

  scoutChunkStopIntervalId = window.setInterval(() => {
    if (!scoutRecorder || scoutRecorder.state !== "recording") {
      return;
    }

    try {
      scoutRecorder.stop();
      scoutRecorder.start(SCOUT_CHUNK_MS);
    } catch (error) {
      console.warn("[SafeView] scoutRecorder stop/restart failed:", error);
    }
  }, SCOUT_CHUNK_MS);

  console.info(
    "[SafeView][Audio-5] Scout recorder started mime=%s tracks=%s state=%s timeslice=%sms",
    scoutRecorder.mimeType,
    audioTracks.length,
    scoutRecorder.state,
    SCOUT_CHUNK_MS
  );

  return true;
}

function stopRecorderOnly(): void {
  stopScoutRecorder();
}

function destroySingletonGraphFully(): void {
  stopScoutRecorder();

  if (singletonMuteRestoreTimeoutId !== null) {
    clearTimeout(singletonMuteRestoreTimeoutId);
    singletonMuteRestoreTimeoutId = null;
  }

  void audioContext?.close();

  audioContext = null;
  singletonGain = null;
  mediaElementSource = null;
  boundVideo = null;
  streamDestination = null;
}

async function createWebAudioScoutStream(
  video: HTMLVideoElement
): Promise<MediaStream | null> {
  prepareVideoCrossOrigin(video);

  if (video.readyState < HAVE_FUTURE_DATA) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("canplay", done);
        resolve();
      };
      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("canplay", done, { once: true });
      window.setTimeout(done, 4000);
    });
  }

  const graph = getOrCreateSingletonGraph(video);
  if (!graph) {
    return null;
  }

  if (graph.context.state !== "running") {
    await graph.context.resume();
  }

  const tracks = graph.streamDestination.stream.getAudioTracks();
  if (tracks.length === 0) {
    console.warn("[SafeView] Web Audio scout stream has no audio tracks.");
    return null;
  }

  if (initializedSources.has(video)) {
    console.info(
      "[SafeView] Reusing singleton scout stream (%s track(s)).",
      tracks.length
    );
  } else {
    console.info(
      "[SafeView] Scout stream via MediaElementSource → singletonGain → MediaStreamDestination (%s track(s)).",
      tracks.length
    );
  }

  return graph.streamDestination.stream;
}

type ScoutStreamSource = "captureStream" | "webAudio";

interface ScoutStreamResult {
  stream: MediaStream;
  source: ScoutStreamSource;
}

async function createScoutMediaStream(
  video: HTMLVideoElement,
  forceWebAudio = false
): Promise<ScoutStreamResult | null> {
  const skipCapture = forceWebAudio || shouldSkipCaptureStream();

  if (!skipCapture && typeof video.captureStream === "function") {
    try {
      const captured = video.captureStream();
      const tracks = captured.getAudioTracks();
      if (tracks.length > 0 && tracks.some((t) => t.readyState !== "ended")) {
        console.info(
          "[SafeView] Scout stream via captureStream (%s audio track(s)).",
          tracks.length
        );
        return {
          stream: toAudioOnlyStream(captured),
          source: "captureStream",
        };
      }
    } catch (error) {
      console.warn(
        "[SafeView] captureStream failed — falling back to Web Audio:",
        error
      );
    }
  } else if (skipCapture) {
    console.info(
      "[SafeView] Skipping captureStream on YouTube — singleton Web Audio pipeline."
    );
  }

  const webAudioStream = await createWebAudioScoutStream(video);
  if (!webAudioStream) {
    return null;
  }

  return { stream: webAudioStream, source: "webAudio" };
}

async function waitForPrimaryVideo(): Promise<HTMLVideoElement | undefined> {
  const discovered = await waitForVideoDiscovery();
  if (discovered) {
    console.info("[SafeView][Audio] Video found — videos=1");
    return discovered;
  }

  await rescanVideosForTargeting(VIDEO_WAIT_ATTEMPTS);
  const video = findPrimaryVisibleVideo();
  if (video) {
    console.info("[SafeView][Audio] Video found after rescan — videos=1");
    return video;
  }

  console.warn("[SafeView][Audio] No visible video after %ss — videos=0", VIDEO_WAIT_ATTEMPTS);
  return undefined;
}

function enforceVisionCpuGuard(reason: string): void {
  hardStopVisionCaptureForAudioPriority(reason, true);
  stopAllSampling();
  console.info("[SafeView][Capture] Vision sampling halted — audio pipeline owns CPU (%s).", reason);
}

export async function startElementAudioFallback(tabId: number): Promise<boolean> {
  console.info(
    "[SafeView][Audio-1] startElementAudioFallback called, tabId=%s",
    tabId
  );

  const settings = await loadSettings();
  if (!isProfanityProtectionActive(settings)) {
    console.info(
      "[SafeView][Audio-1] Profanity off — skipping element audio pipeline."
    );
    stopElementAudioFallback();
    return false;
  }

  enforceVisionCpuGuard("audio-pipeline-start");
  stopRecorderOnly();

  const video = await waitForPrimaryVideo();
  if (!video) {
    console.warn(
      "[SafeView] Element audio fallback — no visible video after %ss.",
      VIDEO_WAIT_ATTEMPTS
    );
    return false;
  }

  try {
    let scoutResult = await createScoutMediaStream(video);
    if (!scoutResult) {
      return false;
    }

    const contextForRecorder =
      audioContext && audioContext.state !== "closed" ? audioContext : null;

    let started = await startScoutRecorder(
      scoutResult.stream,
      tabId,
      video,
      contextForRecorder
    );

    if (!started && scoutResult.source === "captureStream") {
      console.warn(
        "[SafeView] MediaRecorder rejected captureStream — retrying singleton Web Audio."
      );
      stopRecorderOnly();
      scoutResult = await createScoutMediaStream(video, true);
      if (scoutResult) {
        started = await startScoutRecorder(
          scoutResult.stream,
          tabId,
          video,
          audioContext && audioContext.state !== "closed" ? audioContext : null
        );
      }
    }

    if (!started) {
      return false;
    }

    pipelineTabId = tabId;
    enforceVisionCpuGuard("audio-pipeline-active");
    console.log("[SafeView-FINAL] Audio Pipeline Active & Stream Captured");
    return true;
  } catch (error) {
    console.error("[SafeView] Element audio fallback failed:", error);
    stopRecorderOnly();
    return false;
  }
}

function scheduleAudioPipelineRetry(tabId: number, attempt: number): void {
  if (audioStartRetryTimeoutId !== null) {
    clearTimeout(audioStartRetryTimeoutId);
    audioStartRetryTimeoutId = null;
  }

  if (attempt >= MAX_AUDIO_PIPELINE_RETRIES) {
    console.warn("[SafeView] Element audio pipeline — max retries reached.");
    return;
  }

  audioStartRetryTimeoutId = window.setTimeout(() => {
    audioStartRetryTimeoutId = null;
    void (async () => {
      const settings = await loadSettings();
      if (!isProfanityProtectionActive(settings)) {
        return;
      }

      console.info(
        "[SafeView][Audio] Retrying element audio pipeline (attempt %s/%s).",
        attempt + 1,
        MAX_AUDIO_PIPELINE_RETRIES
      );

      const started = await startElementAudioFallback(tabId);
      if (!started) {
        scheduleAudioPipelineRetry(tabId, attempt + 1);
      }
    })();
  }, AUDIO_PIPELINE_RETRY_MS);
}

async function startElementAudioFallbackWithRetry(tabId: number): Promise<void> {
  const started = await startElementAudioFallback(tabId);
  if (!started) {
    scheduleAudioPipelineRetry(tabId, 0);
  }
}

export function stopElementAudioFallback(): void {
  if (audioStartRetryTimeoutId !== null) {
    clearTimeout(audioStartRetryTimeoutId);
    audioStartRetryTimeoutId = null;
  }

  clearReactiveProfanityMute();
  stopRecorderOnly();
  resetElementPipelineGain();
  pipelineTabId = undefined;
}

export function destroyElementAudioPipeline(): void {
  stopElementAudioFallback();
  destroySingletonGraphFully();
}

function handleYouTubeNavigateFinishGainReset(): void {
  clearReactiveProfanityMute();
  resetElementPipelineGain();
}

function setupTrackedVideoGainResetObserver(): void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "attributes") {
        continue;
      }

      const target = mutation.target;
      if (
        target instanceof HTMLVideoElement &&
        target.dataset[SAFE_VIEW_TRACKED_DATASET] === "true"
      ) {
        clearReactiveProfanityMute();
        resetElementPipelineGain();
        break;
      }
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-safe-view-tracked"],
  });
}

function handleProfanityMuteMessage(payload: Record<string, unknown>): void {
  const durationMs =
    typeof payload.duration === "number" && payload.duration > 0
      ? payload.duration
      : typeof payload.duration_ms === "number" && payload.duration_ms > 0
        ? payload.duration_ms
        : MUTE_HOLD_MS;

  const audioAction =
    typeof payload.audio_action === "string" ? payload.audio_action : "";

  if (
    payload.action === MESSAGE_ACTION_ELEMENT_MUTE_GAIN ||
    audioAction === "BEEP" ||
    audioAction === "MUTE"
  ) {
    if (audioAction === "BEEP") {
      showBeepTriggeredNotification();
    }
    applySingletonProfanityMute(durationMs);
  }
}

export function initElementAudioPipelineListener(): void {
  document.addEventListener("yt-navigate-finish", handleYouTubeNavigateFinishGainReset);
  setupTrackedVideoGainResetObserver();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || changes[SETTINGS_STORAGE_KEY] === undefined) {
      return;
    }

    void applyProfanityAudioSettings("storage");
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") {
      return;
    }

    const payload = message as Record<string, unknown>;

    if (
      payload.action === MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK ||
      payload.action === MESSAGE_ACTION_START_AUDIO_PIPELINE
    ) {
      console.log("[SafeView-Handshake] Connection established with Background.");
      const tabId = payload.tabId;
      if (typeof tabId === "number") {
        void startElementAudioFallbackWithRetry(tabId);
      }
      return;
    }

    if (payload.action === MESSAGE_ACTION_STOP_ELEMENT_AUDIO_FALLBACK) {
      stopElementAudioFallback();
      return;
    }

    if (payload.action === MESSAGE_ACTION_ELEMENT_MUTE_GAIN) {
      handleProfanityMuteMessage(payload);
      return;
    }

    if (payload.action === MESSAGE_ACTION_RESET_PIPELINE_GAIN) {
      resetElementPipelineGain();
      return;
    }

    if (payload.action === MESSAGE_ACTION_SETTINGS_UPDATED) {
      const reason =
        typeof payload.reason === "string" ? payload.reason : "message";
      void applyProfanityAudioSettings(reason);
    }
  });
}

export async function applyProfanityAudioSettings(reason: string): Promise<void> {
  const settings = await loadSettings();

  if (isProfanityProtectionActive(settings)) {
    enforceVisionCpuGuard(reason);
    return;
  }

  console.info(
    "[SafeView][Audio] Profanity off (%s) — stopping element audio pipeline.",
    reason
  );
  destroyElementAudioPipeline();
}

export function getElementPipelineTabId(): number | undefined {
  return pipelineTabId;
}

export function isElementAudioPipelineActive(): boolean {
  return (
    pipelineTabId !== undefined &&
    scoutRecorder !== null &&
    scoutRecorder.state === "recording"
  );
}
