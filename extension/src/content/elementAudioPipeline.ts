// SafeView — elementAudioPipeline.ts
// Primary audio path: route native <video> through Web Audio delay vault + scout recorder.

import { loadSettings, SETTINGS_STORAGE_KEY } from "../background/businessRules";
import {
  isProfanityProtectionActive,
  MESSAGE_ACTION_SETTINGS_UPDATED,
} from "../shared/settingsMessages";
import { findPrimaryVisibleVideo } from "./videoMonitor";

/** Service worker → content: start native video element audio graph. */
export const MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK =
  "START_ELEMENT_AUDIO_FALLBACK";

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
const DELAY_SECONDS = 4.5;
const SCOUT_CHUNK_MS = 3000;
const SCOUT_REQUEST_DATA_MS = 1000;
const MIN_BLOB_BYTES = 5000;
const MUTE_HOLD_MS = 3500;
const VOLUME_HAMMER_MS = 200;

/** Matches videoMonitor.ts SAFE_VIEW_TRACKED_DATASET (data-safe-view-tracked). */
const SAFE_VIEW_TRACKED_DATASET = "safeViewTracked";

let pipelineTabId: number | undefined;
let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;
let mediaElementSource: MediaElementAudioSourceNode | null = null;
let boundVideo: HTMLVideoElement | null = null;
let streamDestination: MediaStreamAudioDestinationNode | null = null;
let scoutRecorder: MediaRecorder | null = null;
let scoutRequestDataIntervalId: ReturnType<typeof setInterval> | null = null;
let scoutChunkStopIntervalId: ReturnType<typeof setInterval> | null = null;
let gainRestoreTimeoutId: ReturnType<typeof setTimeout> | null = null;
let volumeGuardVideo: HTMLVideoElement | null = null;
let volumeChangeHandler: ((this: HTMLVideoElement, ev: Event) => void) | null = null;
let volumeHammerIntervalId: ReturnType<typeof setInterval> | null = null;
let nativeSilenceLockActive = false;

/**
 * Set crossOrigin before routing media through Web Audio (CORS analyzer safety).
 *
 * @param video - Target HTMLVideoElement.
 */
export function prepareVideoCrossOrigin(video: HTMLVideoElement): void {
  if (video.crossOrigin !== "anonymous") {
    video.crossOrigin = "anonymous";
  }
}

function resolveRecorderMimeType(): string {
  if (MediaRecorder.isTypeSupported(AUDIO_WEBM_OPUS_MIME)) {
    return AUDIO_WEBM_OPUS_MIME;
  }

  return "audio/webm";
}

/**
 * Bind the video element to Web Audio once per element (MediaElementSource is single-use).
 */
function forceNativeVideoSilent(video: HTMLVideoElement): void {
  if (!video.muted || video.volume > 0) {
    video.muted = true;
    video.volume = 0;
  }
}

/**
 * Lock native <video> output silent so only the Web Audio vault path is audible.
 *
 * @param video - Primary video element tapped by MediaElementSource.
 */
function startNativeVideoSilenceLock(video: HTMLVideoElement): void {
  stopNativeVideoSilenceLock();

  volumeGuardVideo = video;
  nativeSilenceLockActive = true;
  forceNativeVideoSilent(video);

  volumeChangeHandler = () => {
    if (!nativeSilenceLockActive || volumeGuardVideo !== video) {
      return;
    }

    if (!video.muted || video.volume > 0) {
      video.muted = true;
      video.volume = 0;
    }
  };

  video.addEventListener("volumechange", volumeChangeHandler);

  volumeHammerIntervalId = window.setInterval(() => {
    if (!nativeSilenceLockActive || volumeGuardVideo !== video) {
      return;
    }

    video.muted = true;
    video.volume = 0;
  }, VOLUME_HAMMER_MS);

  console.info("[SafeView][Audio-Vault] Native video silence lock active (volume guard + hammer).");
}

function stopNativeVideoSilenceLock(): void {
  nativeSilenceLockActive = false;

  if (volumeHammerIntervalId !== null) {
    clearInterval(volumeHammerIntervalId);
    volumeHammerIntervalId = null;
  }

  if (volumeGuardVideo && volumeChangeHandler) {
    volumeGuardVideo.removeEventListener("volumechange", volumeChangeHandler);
  }

  volumeGuardVideo = null;
  volumeChangeHandler = null;
}

function bindVideoSource(
  video: HTMLVideoElement,
  context: AudioContext
): MediaElementAudioSourceNode {
  if (mediaElementSource && boundVideo === video && mediaElementSource.context === context) {
    return mediaElementSource;
  }

  if (mediaElementSource && boundVideo === video) {
    throw new Error(
      "[SafeView] Video already bound to a previous AudioContext — reload the page."
    );
  }

  const source = context.createMediaElementSource(video);
  mediaElementSource = source;
  boundVideo = video;
  return source;
}

function stopScoutRecorderLoop(): void {
  if (scoutRequestDataIntervalId !== null) {
    clearInterval(scoutRequestDataIntervalId);
    scoutRequestDataIntervalId = null;
  }

  if (scoutChunkStopIntervalId !== null) {
    clearInterval(scoutChunkStopIntervalId);
    scoutChunkStopIntervalId = null;
  }
}

function stopScoutRecorder(): void {
  stopScoutRecorderLoop();

  if (scoutRecorder && scoutRecorder.state !== "inactive") {
    try {
      scoutRecorder.stop();
    } catch {
      /* Already stopped. */
    }
  }

  scoutRecorder = null;
}

function startScoutRecorder(stream: MediaStream, tabId: number): void {
  stopScoutRecorder();

  scoutRecorder = new MediaRecorder(stream, {
    mimeType: resolveRecorderMimeType(),
  });

  scoutRecorder.ondataavailable = async (event: BlobEvent) => {
    if (!event.data || event.data.size < 5000) {
      return;
    }

    console.info(
      "[SafeView][Audio-chunk] Standalone WebM file, size=%s bytes",
      event.data.size
    );

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        return;
      }

      const base64 = reader.result.split(",")[1];
      if (!base64) {
        return;
      }

      console.info(
        "[SafeView][Audio-3] Sending chunk to SW, tabId=%s, base64Len=%s",
        tabId,
        base64.length
      );

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

  scoutRecorder.start();
  console.log(
    "[SafeView] Audio Stream Tracks:",
    stream.getAudioTracks().length
  );
  console.info(
    "[SafeView][Audio-5] Scout recorder started, mimeType=%s, chunkMs=%s, requestDataMs=%s, minBytes=%s, tracks=%s",
    scoutRecorder.mimeType,
    SCOUT_CHUNK_MS,
    SCOUT_REQUEST_DATA_MS,
    MIN_BLOB_BYTES,
    stream.getAudioTracks().length
  );

  scoutRequestDataIntervalId = setInterval(() => {
    if (scoutRecorder && scoutRecorder.state === "recording") {
      scoutRecorder.requestData();
    }
  }, SCOUT_REQUEST_DATA_MS);

  scoutChunkStopIntervalId = setInterval(() => {
    if (scoutRecorder && scoutRecorder.state === "recording") {
      scoutRecorder.stop();
      scoutRecorder.start();
    }
  }, SCOUT_CHUNK_MS);
}

/**
 * Disconnect delay/gain/scout nodes but keep MediaElementSource + AudioContext for restart.
 */
function teardownProcessingGraph(): void {
  stopScoutRecorder();

  if (streamDestination) {
    try {
      streamDestination.disconnect();
    } catch {
      /* Already disconnected. */
    }
    streamDestination = null;
  }

  if (mediaElementSource) {
    try {
      mediaElementSource.disconnect();
    } catch {
      /* Already disconnected. */
    }
  }

  if (gainNode) {
    try {
      gainNode.disconnect();
    } catch {
      /* Already disconnected. */
    }
    gainNode = null;
  }
}

/**
 * Start element-path pipeline: source → delay → gain → destination; scout via streamDest.
 *
 * @param tabId - Tab id for scout chunk routing.
 * @returns True when the graph started successfully.
 */
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

  teardownProcessingGraph();

  const video = findPrimaryVisibleVideo();
  if (!video) {
    console.warn("[SafeView] Element audio fallback — no visible video.");
    return false;
  }

  prepareVideoCrossOrigin(video);

  try {
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext();
      mediaElementSource = null;
      boundVideo = null;
    }

    console.info(
      "[SafeView][Audio-3] AudioContext created, state=%s",
      audioContext.state
    );

    console.info(
      "[SafeView][Audio-Buffer] Vault delay=%ss, standalone record=%sms",
      DELAY_SECONDS,
      SCOUT_CHUNK_MS
    );

    const sourceNode = bindVideoSource(video, audioContext);

    const delayNode = audioContext.createDelay(DELAY_SECONDS + 0.1);
    delayNode.delayTime.value = DELAY_SECONDS;
    gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);

    sourceNode.connect(delayNode);
    delayNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    const streamDest = audioContext.createMediaStreamDestination();
    streamDestination = streamDest;
    sourceNode.connect(streamDest);

    console.log(
      "[SafeView] Audio Stream Tracks:",
      streamDest.stream.getAudioTracks().length
    );

    if (streamDest.stream.getAudioTracks().length === 0) {
      console.warn(
        "[SafeView] MediaStreamDestination has zero audio tracks — scout recording may be empty."
      );
    }

    await audioContext.resume();

    startScoutRecorder(streamDest.stream, tabId);

    startNativeVideoSilenceLock(video);

    console.info("[SafeView][Audio-4] Playback audio playing (element path)");

    pipelineTabId = tabId;

    console.info(
      "[SafeView] Element audio pipeline active — source→delay→gain→destination (tab %s).",
      tabId
    );
    return true;
  } catch (error) {
    console.error("[SafeView] Element audio fallback failed:", error);
    stopElementAudioFallback();
    return false;
  }
}

/**
 * Immediately restore element-path gain to 1.0 and cancel pending mute restores.
 */
export function resetElementPipelineGain(): void {
  if (gainRestoreTimeoutId !== null) {
    clearTimeout(gainRestoreTimeoutId);
    gainRestoreTimeoutId = null;
  }

  if (gainNode && audioContext) {
    gainNode.gain.cancelScheduledValues(audioContext.currentTime);
    gainNode.gain.setValueAtTime(1.0, audioContext.currentTime);
  }
}

/**
 * Mute element-path output using the Web Audio hardware clock.
 *
 * @param durationSeconds - Hold duration before smooth restore.
 */
export function applyElementGainMute(durationSeconds: number = MUTE_HOLD_MS / 1000): void {
  console.info(
    "[SafeView][Audio-7] applyElementGainMute called, gainNode exists=%s, audioContext exists=%s, durationSeconds=%s",
    !!gainNode,
    !!audioContext,
    durationSeconds
  );

  const video = boundVideo ?? findPrimaryVisibleVideo();
  if (video instanceof HTMLVideoElement) {
    video.muted = true;
    video.volume = 0;
  }

  if (!gainNode || !audioContext) {
    console.info("[SafeView][Audio-8] Vault gain mute skipped — no gain node.");
    return;
  }

  if (gainRestoreTimeoutId !== null) {
    clearTimeout(gainRestoreTimeoutId);
    gainRestoreTimeoutId = null;
  }

  const now = audioContext.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(0, now);
  console.info(
    "[SafeView][Audio-8] Gain set to 0 at time=%s, will restore at=%s",
    now,
    now + durationSeconds
  );

  gainRestoreTimeoutId = window.setTimeout(() => {
    gainRestoreTimeoutId = null;
    if (!gainNode || !audioContext) {
      return;
    }

    gainNode.gain.setTargetAtTime(1, audioContext.currentTime, 0.05);
    console.info("[SafeView][Audio-10] Vault gain restored.");
  }, durationSeconds * 1000);

  console.info("[SafeView] Element-path gain muted.");
}

/**
 * Tear down element audio graph and release capture state.
 */
export function stopElementAudioFallback(): void {
  stopNativeVideoSilenceLock();
  teardownProcessingGraph();

  if (gainRestoreTimeoutId !== null) {
    clearTimeout(gainRestoreTimeoutId);
    gainRestoreTimeoutId = null;
  }

  void audioContext?.close();

  audioContext = null;
  gainNode = null;
  mediaElementSource = null;
  boundVideo = null;
  pipelineTabId = undefined;
}

function handleYouTubeNavigateFinishGainReset(): void {
  resetElementPipelineGain();
}

/**
 * Reset gain when videoMonitor registers a new tracked <video>.
 */
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

/**
 * Listen for element-fallback commands from the service worker.
 */
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

    if (payload.action === MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK) {
      const tabId = payload.tabId;
      if (typeof tabId === "number") {
        void startElementAudioFallback(tabId).then((started) => {
          if (!started) {
            stopElementAudioFallback();
          }
        });
      }
      return;
    }

    if (payload.action === MESSAGE_ACTION_STOP_ELEMENT_AUDIO_FALLBACK) {
      stopElementAudioFallback();
      return;
    }

    if (payload.action === MESSAGE_ACTION_ELEMENT_MUTE_GAIN) {
      const durationMs =
        typeof payload.duration === "number" && payload.duration > 0
          ? payload.duration
          : typeof payload.duration_ms === "number" && payload.duration_ms > 0
            ? payload.duration_ms
            : MUTE_HOLD_MS;
      applyElementGainMute(durationMs / 1000);
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

/**
 * Stop the audio pipeline when profanity is disabled; no-op when still enabled.
 */
export async function applyProfanityAudioSettings(reason: string): Promise<void> {
  const settings = await loadSettings();
  if (!isProfanityProtectionActive(settings)) {
    console.info(
      "[SafeView][Audio] Profanity off (%s) — stopping element audio pipeline.",
      reason
    );
    stopElementAudioFallback();
  }
}

export function getElementPipelineTabId(): number | undefined {
  return pipelineTabId;
}

export function isElementAudioPipelineActive(): boolean {
  return pipelineTabId !== undefined && audioContext !== null;
}
