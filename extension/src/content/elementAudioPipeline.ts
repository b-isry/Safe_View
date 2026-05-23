// SafeView — elementAudioPipeline.ts
// Primary audio path: route native <video> through Web Audio delay vault + scout recorder.

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
const DELAY_SECONDS = 1.5;
const SCOUT_CHUNK_MS = 1000;
const MIN_BLOB_BYTES = 500;
const MUTE_HOLD_MS = 1500;

/** Matches videoMonitor.ts SAFE_VIEW_TRACKED_DATASET (data-safe-view-tracked). */
const SAFE_VIEW_TRACKED_DATASET = "safeViewTracked";

let pipelineTabId: number | undefined;
let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;
let mediaElementSource: MediaElementAudioSourceNode | null = null;
let boundVideo: HTMLVideoElement | null = null;
let streamDestination: MediaStreamAudioDestinationNode | null = null;
let scoutRecorder: MediaRecorder | null = null;
let scoutRecorderIntervalId: ReturnType<typeof setInterval> | null = null;
let gainRestoreTimeoutId: ReturnType<typeof setTimeout> | null = null;

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
  if (scoutRecorderIntervalId !== null) {
    clearInterval(scoutRecorderIntervalId);
    scoutRecorderIntervalId = null;
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
    if (!event.data || event.data.size < MIN_BLOB_BYTES) {
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
  console.info(
    "[SafeView][Audio-5] Scout recorder started, mimeType=%s, intervalMs=%s, tracks=%s",
    scoutRecorder.mimeType,
    SCOUT_CHUNK_MS,
    stream.getAudioTracks().length
  );

  scoutRecorderIntervalId = setInterval(() => {
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

    const trackCount = streamDest.stream.getAudioTracks().length;
    console.info(
      "[SafeView][Audio-2] MediaStreamDestination created, audioTracks=%s",
      trackCount
    );

    if (trackCount === 0) {
      console.warn(
        "[SafeView] MediaStreamDestination has zero audio tracks — scout recording may be empty."
      );
    }

    startScoutRecorder(streamDest.stream, tabId);

    console.info("[SafeView][Audio-4] Playback audio playing (element path)");

    await audioContext.resume();
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
export function applyElementGainMute(durationSeconds: number = DELAY_SECONDS): void {
  console.info(
    "[SafeView][Audio-7] applyElementGainMute called, gainNode exists=%s, audioContext exists=%s, durationSeconds=%s",
    !!gainNode,
    !!audioContext,
    durationSeconds
  );

  if (!gainNode || !audioContext) {
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
  }, durationSeconds * 1000);

  console.info("[SafeView] Element-path gain muted.");
}

/**
 * Tear down element audio graph and release capture state.
 */
export function stopElementAudioFallback(): void {
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

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") {
      return;
    }

    const payload = message as Record<string, unknown>;

    if (payload.action === MESSAGE_ACTION_START_ELEMENT_AUDIO_FALLBACK) {
      const tabId = payload.tabId;
      if (typeof tabId === "number") {
        void startElementAudioFallback(tabId);
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
    }
  });
}

export function getElementPipelineTabId(): number | undefined {
  return pipelineTabId;
}

export function isElementAudioPipelineActive(): boolean {
  return pipelineTabId !== undefined && audioContext !== null;
}
