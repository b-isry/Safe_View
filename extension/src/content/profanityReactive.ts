// SafeView — profanityReactive.ts
// Reactive profanity mute: video.muted + isolated 440 Hz beep (independent of video volume).

import { PROFANITY_MUTE_DURATION_MS } from "../background/businessRules";

const BEEP_FREQUENCY_HZ = 440;
/** Master output level — wired directly to AudioContext.destination, not the video graph. */
const BEEP_MASTER_GAIN_LEVEL = 0.35;

let beepContext: AudioContext | null = null;
/** Persistent master gain so the beep stays audible when video.muted / volume = 0. */
let beepMasterGain: GainNode | null = null;
let beepOscillator: OscillatorNode | null = null;
let beepToneGain: GainNode | null = null;
let videoMuteRestoreTimeoutId: ReturnType<typeof setTimeout> | null = null;

function ensureBeepAudioGraph(): AudioContext | null {
  try {
    if (!beepContext || beepContext.state === "closed") {
      beepContext = new AudioContext();
      beepMasterGain = beepContext.createGain();
      beepMasterGain.gain.value = BEEP_MASTER_GAIN_LEVEL;
      beepMasterGain.connect(beepContext.destination);
    }

    return beepContext;
  } catch (error) {
    console.error("[SafeView] Failed to create beep AudioContext:", error);
    return null;
  }
}

function stopReactiveBeep(): void {
  if (beepOscillator) {
    try {
      beepOscillator.stop();
    } catch {
      /* Already stopped. */
    }
    beepOscillator.disconnect();
    beepOscillator = null;
  }

  if (beepToneGain) {
    beepToneGain.disconnect();
    beepToneGain = null;
  }
}

function playReactiveBeep(durationMs: number): void {
  const context = ensureBeepAudioGraph();
  if (!context || !beepMasterGain) {
    return;
  }

  void context.resume();

  stopReactiveBeep();

  const osc = context.createOscillator();
  const toneGain = context.createGain();
  osc.type = "sine";
  osc.frequency.value = BEEP_FREQUENCY_HZ;
  toneGain.gain.value = 1;

  osc.connect(toneGain);
  toneGain.connect(beepMasterGain);

  const durationSeconds = durationMs / 1000;
  const now = context.currentTime;
  osc.start(now);
  osc.stop(now + durationSeconds);

  beepOscillator = osc;
  beepToneGain = toneGain;
}

/**
 * Reactive profanity response: mute the video element and play a 440 Hz beep (no delay vault).
 *
 * @param video - Target HTMLVideoElement.
 * @param durationMs - Mute hold (default PROFANITY_MUTE_DURATION_MS / 1500).
 */
export function triggerWebBeep(
  video: HTMLVideoElement,
  durationMs: number = PROFANITY_MUTE_DURATION_MS
): void {
  console.log("!!! TRIGGERING BEEP NOW !!!");

  if (videoMuteRestoreTimeoutId !== null) {
    clearTimeout(videoMuteRestoreTimeoutId);
    videoMuteRestoreTimeoutId = null;
  }

  const previousVolume = video.volume;
  video.muted = true;
  video.volume = 0;

  playReactiveBeep(durationMs);

  console.info(
    "[SafeView] Reactive profanity mute — beep + video.muted for %sms",
    durationMs
  );

  videoMuteRestoreTimeoutId = window.setTimeout(() => {
    videoMuteRestoreTimeoutId = null;
    stopReactiveBeep();
    video.muted = false;
    video.volume = previousVolume;
    console.info("[SafeView] Reactive profanity mute restored.");
  }, durationMs);
}

/**
 * Cancel pending reactive mute/beep (pipeline stop or navigation).
 */
export function clearReactiveProfanityMute(): void {
  if (videoMuteRestoreTimeoutId !== null) {
    clearTimeout(videoMuteRestoreTimeoutId);
    videoMuteRestoreTimeoutId = null;
  }

  stopReactiveBeep();
}
