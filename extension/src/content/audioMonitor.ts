// SafeView — audioMonitor.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Subtitle cue profanity (instant mute) and MUTE commands from the service worker.
// Tab-capture audio runs in the offscreen document — not in this content script.

import { loadSettings, MUTE_DURATION_MS } from "../background/businessRules";
import { getVideoById } from "./videoMonitor";

/** Service worker → content script: mute video element (BR-05). */
export const MESSAGE_ACTION_MUTE = "MUTE";

/** Service worker → content script: suppress native page video speakers (H5). */
export const MESSAGE_ACTION_SET_TAB_SPEAKER_SUPPRESSED =
  "SET_TAB_SPEAKER_SUPPRESSED";

/**
 * Incoming mute command from the service worker.
 */
export interface MuteCommandMessage {
  action: typeof MESSAGE_ACTION_MUTE;
  videoId: number;
  duration_ms: number;
}

/**
 * Per-video subtitle monitor state (mute timeouts and cue listeners).
 */
interface SubtitleMonitorState {
  muteTimeoutId: ReturnType<typeof setTimeout> | null;
  cueHandlers: Array<{ track: TextTrack; handler: () => void }>;
  addTrackHandler: ((event: Event) => void) | null;
}

const subtitleMonitors = new WeakMap<HTMLVideoElement, SubtitleMonitorState>();

let tabSpeakerSuppressed = false;

/**
 * Set crossOrigin for CORS-safe Web Audio / analyzer access on media elements.
 *
 * @param video - HTMLVideoElement to prepare.
 */
export function prepareVideoCrossOrigin(video: HTMLVideoElement): void {
  if (video.crossOrigin !== "anonymous") {
    video.crossOrigin = "anonymous";
  }
}

/**
 * Return true when text contains any blacklist term (substring match).
 *
 * @param text - Subtitle cue text.
 * @param words - User profanity list from settings (BR-03).
 */
function subtitleTextMatchesProfanity(text: string, words: string[]): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  for (const word of words) {
    const term = word.trim().toLowerCase();
    if (term.length > 0 && normalized.includes(term)) {
      return true;
    }
  }

  return false;
}

/**
 * Mute a video for exactly duration_ms (BR-05), then unmute.
 *
 * @param video - Target HTMLVideoElement.
 * @param durationMs - Mute hold (expected 1500).
 * @param state - Optional monitor state for timeout cleanup.
 */
export function applyMute(
  video: HTMLVideoElement,
  durationMs: number,
  state?: SubtitleMonitorState
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
 * Handle cuechange on a text track — instant mute when profanity appears in subtitles.
 *
 * @param video - Video element showing the track.
 */
function handleCueChange(video: HTMLVideoElement): void {
  void (async () => {
    const settings = await loadSettings();
    if (!settings.protectionEnabled || !settings.categories.profanity) {
      return;
    }

    if (settings.profanityWords.length === 0) {
      return;
    }

    const tracks = video.textTracks;
    let cueText = "";

    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      if (!track.activeCues) {
        continue;
      }

      for (let j = 0; j < track.activeCues.length; j += 1) {
        const cue = track.activeCues[j];
        if (cue && "text" in cue) {
          cueText += `${(cue as VTTCue).text} `;
        }
      }
    }

    if (!subtitleTextMatchesProfanity(cueText, settings.profanityWords)) {
      return;
    }

    const state = subtitleMonitors.get(video);
    applyMute(video, MUTE_DURATION_MS, state);
    console.info("[SafeView] Subtitle profanity detected — video muted.");
  })();
}

/**
 * Bind cuechange listeners on subtitle/caption tracks for one video.
 *
 * @param video - HTMLVideoElement to monitor.
 */
function bindTextTracks(video: HTMLVideoElement, state: SubtitleMonitorState): void {
  const onCue = () => {
    handleCueChange(video);
  };

  const enableTrack = (track: TextTrack) => {
    if (track.kind !== "subtitles" && track.kind !== "captions") {
      return;
    }

    track.mode = "hidden";
    track.addEventListener("cuechange", onCue);
    state.cueHandlers.push({ track, handler: onCue });
  };

  for (let i = 0; i < video.textTracks.length; i += 1) {
    enableTrack(video.textTracks[i]!);
  }

  const onAddTrack = (event: Event) => {
    const track = (event as TrackEvent).track;
    if (track) {
      enableTrack(track);
    }
  };

  video.textTracks.addEventListener("addtrack", onAddTrack);
  state.addTrackHandler = onAddTrack;
}

/**
 * Start subtitle cue monitoring for instant profanity mute (no tab/audio capture here).
 *
 * @param video - HTMLVideoElement already registered in videoMonitor.
 */
export function startSubtitleMonitor(video: HTMLVideoElement): void {
  if (subtitleMonitors.has(video)) {
    return;
  }

  const state: SubtitleMonitorState = {
    muteTimeoutId: null,
    cueHandlers: [],
    addTrackHandler: null,
  };

  bindTextTracks(video, state);
  subtitleMonitors.set(video, state);
}

/**
 * Stop subtitle monitoring and clear cue listeners for a video.
 *
 * @param video - HTMLVideoElement being unregistered.
 */
export function stopSubtitleMonitor(video: HTMLVideoElement): void {
  const state = subtitleMonitors.get(video);
  if (!state) {
    return;
  }

  if (state.muteTimeoutId !== null) {
    clearTimeout(state.muteTimeoutId);
    state.muteTimeoutId = null;
  }

  for (const { track, handler } of state.cueHandlers) {
    track.removeEventListener("cuechange", handler);
  }

  if (state.addTrackHandler) {
    video.textTracks.removeEventListener("addtrack", state.addTrackHandler);
  }

  subtitleMonitors.delete(video);
}

/**
 * Silence native <video> speaker output so only the offscreen delayed path is audible.
 *
 * @param video - Page video element.
 */
function applyTabSpeakerStateToVideo(video: HTMLVideoElement): void {
  if (!tabSpeakerSuppressed) {
    if (video.dataset.safeviewSpeakerHeld === "true") {
      video.muted = video.dataset.safeviewPrevMuted === "true";
      video.volume = Number(video.dataset.safeviewPrevVolume ?? "1");
      delete video.dataset.safeviewSpeakerHeld;
      delete video.dataset.safeviewPrevMuted;
      delete video.dataset.safeviewPrevVolume;
    }
    return;
  }

  if (video.dataset.safeviewSpeakerHeld !== "true") {
    video.dataset.safeviewPrevMuted = video.muted ? "true" : "false";
    video.dataset.safeviewPrevVolume = String(video.volume);
    video.dataset.safeviewSpeakerHeld = "true";
  }

  video.muted = true;
  video.volume = 0;
}

/**
 * Apply or release native speaker suppression on all page videos.
 *
 * @param suppress - When true, mute page videos so offscreen gain is the only output.
 */
export function setTabSpeakerSuppressed(suppress: boolean): void {
  tabSpeakerSuppressed = suppress;
  document.querySelectorAll("video").forEach((video) => {
    applyTabSpeakerStateToVideo(video);
  });
  console.info(
    "[SafeView] Tab native speaker suppression %s.",
    suppress ? "enabled" : "disabled"
  );
}

/**
 * Cancel BR-05 subtitle mutes and restore native video mute state (not tab-speaker suppression).
 */
export function clearProcessingMutesOnNavigation(): void {
  document.querySelectorAll("video").forEach((video) => {
    const state = subtitleMonitors.get(video);
    if (state?.muteTimeoutId !== null && state?.muteTimeoutId !== undefined) {
      clearTimeout(state.muteTimeoutId);
      state.muteTimeoutId = null;
    }

    if (video.dataset.safeviewSpeakerHeld === "true") {
      return;
    }

    video.muted = false;
  });
}

/**
 * Called when a new video is tracked while suppression is active (SPA navigation).
 *
 * @param video - Newly registered HTMLVideoElement.
 */
export function onVideoTrackedForSpeakerSuppression(video: HTMLVideoElement): void {
  if (tabSpeakerSuppressed) {
    applyTabSpeakerStateToVideo(video);
  }
}

/**
 * Listen for MUTE and tab-speaker commands from the service worker.
 */
export function initAudioMuteListener(): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") {
      return;
    }

    const payload = message as Record<string, unknown>;

    if (payload.action === MESSAGE_ACTION_SET_TAB_SPEAKER_SUPPRESSED) {
      setTabSpeakerSuppressed(Boolean(payload.suppress));
      return;
    }

    if (payload.action !== MESSAGE_ACTION_MUTE) {
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

    const state = subtitleMonitors.get(video);
    applyMute(video, durationMs, state);
  });
}
