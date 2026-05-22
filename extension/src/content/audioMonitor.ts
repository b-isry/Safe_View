// SafeView — audioMonitor.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Record WebM audio chunks from <video> and mute on profanity (BR-05).

import {
  DEFAULT_AUDIO_LANGUAGE,
  loadSettings,
  MUTE_DURATION_MS,
  SETTINGS_STORAGE_KEY,
  type AudioLanguage,
} from "../background/businessRules";
import {
  findPrimaryVisibleVideo,
  getVideoById,
  getVideoTrackState,
} from "./videoMonitor";

/** Content script → service worker: WebM/Opus audio chunk. */
export const MESSAGE_ACTION_AUDIO_CHUNK = "AUDIO_CHUNK";

/** Service worker → content script: mute video for BR-05 duration. */
export const MESSAGE_ACTION_MUTE = "MUTE";

/** MediaRecorder timeslice / chunk length (ms). */
export const AUDIO_CHUNK_MS = 2000;

/** Preferred Opus-in-WebM MIME type for MediaRecorder. */
export const AUDIO_WEBM_OPUS_MIME = "audio/webm;codecs=opus";

/** Chunk size for base64 encoding (avoids spread-arg limits on large buffers). */
const BASE64_CHUNK_SIZE = 0x8000;

/**
 * Per-video MediaRecorder state.
 */
interface AudioMonitorState {
  videoId: number;
  stream: MediaStream;
  recorder: MediaRecorder;
  muteTimeoutId: ReturnType<typeof setTimeout> | null;
}

const audioMonitors = new WeakMap<HTMLVideoElement, AudioMonitorState>();

/**
 * Incoming mute command from the service worker.
 */
export interface MuteCommandMessage {
  action: typeof MESSAGE_ACTION_MUTE;
  videoId: number;
  duration_ms: number;
}

/**
 * Resolve MediaRecorder MIME type supported by the browser.
 *
 * @returns audio/webm;codecs=opus when supported, else audio/webm.
 */
function resolveRecorderMimeType(): string {
  if (
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported(AUDIO_WEBM_OPUS_MIME)
  ) {
    return AUDIO_WEBM_OPUS_MIME;
  }

  return "audio/webm";
}

/**
 * Encode audio bytes as base64 for chrome.runtime.sendMessage.
 *
 * @param buffer - Raw chunk bytes from MediaRecorder.
 * @returns Base64 string safe for message passing.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * Read Whisper language from chrome.storage.local settings (default en).
 *
 * @returns Audio language code for /analyze-audio.
 */
export async function resolveAudioLanguage(): Promise<AudioLanguage> {
  try {
    const settings = await loadSettings();
    return settings.language === "am" ? "am" : DEFAULT_AUDIO_LANGUAGE;
  } catch {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
      const raw = stored[SETTINGS_STORAGE_KEY] as { language?: string } | undefined;
      return raw?.language === "am" ? "am" : DEFAULT_AUDIO_LANGUAGE;
    } catch {
      return DEFAULT_AUDIO_LANGUAGE;
    }
  }
}

/**
 * Send one audio chunk to the service worker; discard blob after encoding (BR-02).
 *
 * @param chunk - WebM blob from MediaRecorder (not retained after send).
 * @param video - Source video element.
 * @param videoId - Stable id for this video.
 */
async function sendAudioChunk(
  chunk: Blob,
  video: HTMLVideoElement,
  videoId: number
): Promise<void> {
  const primaryVideo = findPrimaryVisibleVideo();
  if (primaryVideo && primaryVideo !== video) {
    return;
  }

  if (chunk.size === 0) {
    return;
  }

  const language = await resolveAudioLanguage();

  try {
    const audioBase64 = arrayBufferToBase64(await chunk.arrayBuffer());

    void chrome.runtime
      .sendMessage({
        action: MESSAGE_ACTION_AUDIO_CHUNK,
        audioBase64,
        language,
        videoId,
      })
      .catch(() => {
        /* Fire-and-forget; service worker acks immediately. */
      });
  } catch (error) {
    console.warn("[SafeView] Could not send audio chunk:", error);
  }
}

/**
 * Mute a video for exactly duration_ms (BR-05), then restore prior muted state.
 *
 * @param video - Target HTMLVideoElement.
 * @param durationMs - Mute hold from backend (expected 1500).
 * @param state - Optional monitor state holding the active timeout id.
 */
function applyMute(
  video: HTMLVideoElement,
  durationMs: number,
  state?: AudioMonitorState
): void {
  if (state?.muteTimeoutId !== null && state?.muteTimeoutId !== undefined) {
    clearTimeout(state.muteTimeoutId);
  }

  video.muted = true;

  const timeoutId = window.setTimeout(() => {
    video.muted = false;
    if (state) {
      state.muteTimeoutId = null;
    }
  }, durationMs);

  if (state) {
    state.muteTimeoutId = timeoutId;
  }
}

/**
 * Begin 2-second WebM/Opus recording on a tracked video element.
 *
 * @param video - HTMLVideoElement already registered in videoMonitor.
 */
export function startAudioMonitor(video: HTMLVideoElement): void {
  if (audioMonitors.has(video)) {
    return;
  }

  const trackState = getVideoTrackState(video);
  if (!trackState) {
    return;
  }

  if (typeof video.captureStream !== "function") {
    console.warn("[SafeView] Audio capture unavailable for this source");
    return;
  }

  let stream: MediaStream;

  try {
    stream = video.captureStream();
  } catch {
    console.warn("[SafeView] Audio capture unavailable for this source");
    return;
  }

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    console.warn("[SafeView] Audio capture unavailable for this source");
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  let recorder: MediaRecorder;

  try {
    recorder = new MediaRecorder(stream, {
      mimeType: resolveRecorderMimeType(),
    });
  } catch {
    console.warn("[SafeView] Audio capture unavailable for this source");
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  const monitorState: AudioMonitorState = {
    videoId: trackState.videoId,
    stream,
    recorder,
    muteTimeoutId: null,
  };

  recorder.ondataavailable = (event: BlobEvent) => {
    const chunk = event.data;
    if (!chunk || chunk.size === 0) {
      return;
    }

    void sendAudioChunk(chunk, video, trackState.videoId);
  };

  try {
    recorder.start(AUDIO_CHUNK_MS);
  } catch {
    console.warn("[SafeView] Audio capture unavailable for this source");
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  audioMonitors.set(video, monitorState);
}

/**
 * Stop MediaRecorder and release capture stream tracks for a video.
 *
 * @param video - HTMLVideoElement being unregistered.
 */
export function stopAudioMonitor(video: HTMLVideoElement): void {
  const state = audioMonitors.get(video);
  if (!state) {
    return;
  }

  if (state.muteTimeoutId !== null) {
    clearTimeout(state.muteTimeoutId);
    state.muteTimeoutId = null;
  }

  if (state.recorder.state !== "inactive") {
    try {
      state.recorder.stop();
    } catch {
      /* Recorder may already be stopped when the element is removed. */
    }
  }

  state.stream.getTracks().forEach((track) => track.stop());
  audioMonitors.delete(video);
}

/**
 * Listen for MUTE commands from the service worker and apply BR-05 mute duration.
 */
export function initAudioMuteListener(): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as MuteCommandMessage).action !== MESSAGE_ACTION_MUTE
    ) {
      return;
    }

    const command = message as MuteCommandMessage;
    if (typeof command.videoId !== "number") {
      return;
    }

    const video = getVideoById(command.videoId);
    if (!video) {
      return;
    }

    const durationMs =
      typeof command.duration_ms === "number" && command.duration_ms > 0
        ? command.duration_ms
        : MUTE_DURATION_MS;

    const state = audioMonitors.get(video);
    applyMute(video, durationMs, state);
  });
}
