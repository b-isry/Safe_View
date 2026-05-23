console.info("[SafeView][Offscreen] audioProcessor.ts loaded successfully");

// SafeView — offscreen/audioProcessor.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Offscreen tab-capture audio — delay vault (Path B) + scout chunks to Whisper (Path A).

/** Service worker → offscreen: start pipeline with tab capture stream id. */
const MESSAGE_ACTION_INIT_AUDIO_PIPELINE = "INIT_AUDIO_PIPELINE";

/** Service worker → offscreen: tear down Web Audio graph and recorders. */
const MESSAGE_ACTION_STOP_AUDIO_PIPELINE = "STOP_AUDIO_PIPELINE";

/** Service worker → offscreen: mute delayed output via gain node (BR-05). */
const MESSAGE_ACTION_MUTE_GAIN = "MUTE_GAIN";

/** Service worker → offscreen: force delayed-path gain back to 1.0. */
const MESSAGE_ACTION_RESET_PIPELINE_GAIN = "RESET_PIPELINE_GAIN";

/** Offscreen → service worker: WebM chunk for /analyze-audio. */
const MESSAGE_ACTION_AUDIO_CHUNK_PIPELINE = "AUDIO_CHUNK_PIPELINE";

/** Offscreen → service worker: tab capture init failed. */
const MESSAGE_ACTION_TAB_CAPTURE_INIT_FAILED = "TAB_CAPTURE_INIT_FAILED";

/** Preferred Opus-in-WebM MIME type for scout MediaRecorder. */
const AUDIO_WEBM_OPUS_MIME = "audio/webm;codecs=opus";

/** Delay vault length (seconds) — user hears audio this many seconds late. */
const DELAY_SECONDS = 1.1;

/** Scout chunk timeslice (ms) — MediaRecorder emits a blob every interval. */
const SCOUT_CHUNK_MS = 800;

/** Minimum base64 length before sending a chunk to the service worker. */
const MIN_CHUNK_BASE64_LEN = 2000;

/** Whisper must finish before delayed audio reaches the user (ms). */
const WHISPER_PROCESSING_BUDGET_MS = 1000;

/** BR-05 mute hold (ms) — covers profanity word and surrounding context. */
const MUTE_HOLD_MS = 1500;

/** Chrome tab-capture constraint shape for getUserMedia in extension offscreen docs. */
interface ChromeTabCaptureAudioConstraints {
  audio: {
    mandatory: {
      chromeMediaSource: "tab";
      chromeMediaSourceId: string;
    };
  };
  video: false;
}

let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let analyserNode: AnalyserNode | null = null;
let mediaStream: MediaStream | null = null;
let scoutRecorder: MediaRecorder | null = null;
let gainRestoreTimeoutId: ReturnType<typeof setTimeout> | null = null;
let firstHeader: Blob | null = null;

let activePipelineTabId: number | undefined;

/**
 * Resolve MediaRecorder MIME type supported in this document.
 */
function resolveRecorderMimeType(): string {
  if (MediaRecorder.isTypeSupported(AUDIO_WEBM_OPUS_MIME)) {
    return AUDIO_WEBM_OPUS_MIME;
  }

  return "audio/webm";
}

/**
 * Bind tab capture stream and build delay vault + scout recorder graph.
 *
 * @param streamId - Id from chrome.tabCapture.getMediaStreamId.
 * @param tabId - Tab being monitored (forwarded with each scout chunk).
 */
async function initPipeline(streamId: string, tabId: number): Promise<void> {
  console.info(
    "[SafeView][Audio-1] initPipeline called, streamId=%s, tabId=%s",
    streamId,
    tabId
  );

  teardown();
  activePipelineTabId = tabId;

  const constraints: ChromeTabCaptureAudioConstraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(
      constraints as unknown as MediaStreamConstraints
    );
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(
      "[SafeView][Audio-FAIL] getUserMedia failed:",
      err.name,
      err.message
    );
    void chrome.runtime
      .sendMessage({
        action: MESSAGE_ACTION_TAB_CAPTURE_INIT_FAILED,
        tabId,
        error: err.message,
      })
      .catch(() => {});
    return;
  }

  console.info(
    "[SafeView][Audio-2] getUserMedia succeeded, tracks=%s",
    mediaStream.getTracks().length
  );

  try {
    audioContext = new AudioContext();
    console.info(
      "[SafeView][Audio-3] AudioContext created, state=%s",
      audioContext.state
    );

    if (WHISPER_PROCESSING_BUDGET_MS >= DELAY_SECONDS * 1000) {
      console.warn(
        "[SafeView] WHISPER_PROCESSING_BUDGET_MS should be less than delay window (%sms).",
        DELAY_SECONDS * 1000
      );
    }

    console.info(
      "[SafeView][Audio-Buffer] Vault delay set to 1.1s, Scout chunk set to 800ms"
    );

    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;

    const delayNode = audioContext.createDelay(DELAY_SECONDS + 0.1);
    delayNode.delayTime.value = DELAY_SECONDS;
    gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);

    const scoutDestination = audioContext.createMediaStreamDestination();

    sourceNode.connect(analyserNode);
    sourceNode.connect(delayNode);
    delayNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    sourceNode.connect(scoutDestination);

    console.info("[SafeView][Audio-4] Playback audio playing");

    await audioContext.resume();

    startScoutRecorder(scoutDestination.stream, tabId);

    console.info("[SafeView] Offscreen audio pipeline started for tab %s.", tabId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("[SafeView] Offscreen initPipeline failed:", err.name, err.message);
    teardown();
    void chrome.runtime
      .sendMessage({
        action: MESSAGE_ACTION_TAB_CAPTURE_INIT_FAILED,
        tabId,
        error: err.message,
      })
      .catch(() => {});
  }
}

/**
 * Record 800ms WebM timeslices from the scout tap; prepend EBML header to each chunk.
 *
 * @param stream - Scout branch MediaStream (instant, undelayed).
 * @param tabId - Tab id for backend routing.
 */
function startScoutRecorder(stream: MediaStream, tabId: number): void {
  firstHeader = null;

  const mimeType = resolveRecorderMimeType();
  scoutRecorder = new MediaRecorder(stream, { mimeType });

  scoutRecorder.ondataavailable = async (event: BlobEvent) => {
    if (!event.data || event.data.size < 100) {
      return;
    }

    let blobToSend = event.data;

    if (!firstHeader) {
      firstHeader = event.data;
    } else {
      blobToSend = new Blob([firstHeader, event.data], { type: mimeType });
    }

    console.info(
      "[SafeView][Audio-chunk] Chunk available, raw=%s bytes, send=%s bytes",
      event.data.size,
      blobToSend.size
    );

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        return;
      }

      const base64 = reader.result.split(",")[1];
      if (!base64 || base64.length <= MIN_CHUNK_BASE64_LEN) {
        return;
      }

      const capturedAt = audioContext?.currentTime ?? 0;
      console.info(
        "[SafeView][Audio-3] Sending chunk to SW, tabId=%s, base64Len=%s",
        tabId,
        base64.length
      );

      void chrome.runtime
        .sendMessage({
          action: MESSAGE_ACTION_AUDIO_CHUNK_PIPELINE,
          payload: base64,
          audioBase64: base64,
          capturedAt,
          tabId,
        })
        .catch(() => {});
    };
    reader.readAsDataURL(blobToSend);
  };

  scoutRecorder.start(SCOUT_CHUNK_MS);
  console.info(
    "[SafeView][Audio-5] Scout recorder started, mimeType=%s, timesliceMs=%s",
    scoutRecorder.mimeType,
    SCOUT_CHUNK_MS
  );
}

/**
 * Mute delayed vault output now; restore gain smoothly after BR-05 duration.
 */
function resetOffscreenPipelineGain(): void {
  if (gainRestoreTimeoutId !== null) {
    clearTimeout(gainRestoreTimeoutId);
    gainRestoreTimeoutId = null;
  }

  if (!gainNode || !audioContext) {
    return;
  }

  const now = audioContext.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(1, now);
}

function applyGainMute(durationSeconds: number = DELAY_SECONDS): void {
  console.info(
    "[SafeView][Audio-7] applyGainMute called, gainNode exists=%s, audioContext exists=%s, durationSeconds=%s",
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

  console.info("[SafeView] Gain muted via delay pipeline.");
}

/**
 * Release Web Audio graph and capture tracks.
 */
function teardown(): void {
  firstHeader = null;

  if (gainRestoreTimeoutId !== null) {
    clearTimeout(gainRestoreTimeoutId);
    gainRestoreTimeoutId = null;
  }

  if (scoutRecorder && scoutRecorder.state !== "inactive") {
    try {
      scoutRecorder.stop();
    } catch {
      /* Already stopped. */
    }
  }

  scoutRecorder = null;

  void audioContext?.close();
  mediaStream?.getTracks().forEach((track) => track.stop());

  audioContext = null;
  gainNode = null;
  sourceNode = null;
  analyserNode = null;
  mediaStream = null;
  activePipelineTabId = undefined;
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object") {
    return;
  }

  const payload = message as Record<string, unknown>;

  if (payload.action === MESSAGE_ACTION_INIT_AUDIO_PIPELINE) {
    const streamId = payload.streamId;
    const tabId = payload.tabId;

    if (typeof streamId === "string" && typeof tabId === "number") {
      void initPipeline(streamId, tabId);
    }

    return;
  }

  if (payload.action === MESSAGE_ACTION_STOP_AUDIO_PIPELINE) {
    teardown();
    return;
  }

  if (payload.action === MESSAGE_ACTION_MUTE_GAIN) {
    const durationMs =
      typeof payload.duration === "number" && payload.duration > 0
        ? payload.duration
        : typeof payload.duration_ms === "number" && payload.duration_ms > 0
          ? payload.duration_ms
          : MUTE_HOLD_MS;

    applyGainMute(durationMs / 1000);
    return;
  }

  if (payload.action === MESSAGE_ACTION_RESET_PIPELINE_GAIN) {
    resetOffscreenPipelineGain();
    console.info("[SafeView] Offscreen pipeline gain reset to 1.0.");
  }
});

/** Marker export for Vite entry (pipeline initializes via runtime messages). */
export const OFFSCREEN_AUDIO_PROCESSOR_READY = true;
