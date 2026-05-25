// SafeView — audioPipelineStatus.ts
// Persist profanity audio pipeline lifecycle for popup diagnostics.

/** chrome.storage.local key for audio pipeline status. */
export const AUDIO_PIPELINE_STATUS_STORAGE_KEY = "safeViewAudioPipelineStatus";

export type AudioPipelineMode = "element" | "offscreen" | null;

/** Audio pipeline snapshot written by the service worker. */
export interface AudioPipelineStatus {
  running: boolean;
  mode: AudioPipelineMode;
  tabId: number | null;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  lastError: string | null;
}

const DEFAULT_AUDIO_PIPELINE_STATUS: AudioPipelineStatus = {
  running: false,
  mode: null,
  tabId: null,
  lastStartedAt: null,
  lastStoppedAt: null,
  lastError: null,
};

let cachedAudioPipelineStatus: AudioPipelineStatus = {
  ...DEFAULT_AUDIO_PIPELINE_STATUS,
};

export function getAudioPipelineStatus(): AudioPipelineStatus {
  return { ...cachedAudioPipelineStatus };
}

export async function setAudioPipelineStatus(
  partial: Partial<AudioPipelineStatus>
): Promise<AudioPipelineStatus> {
  cachedAudioPipelineStatus = {
    ...cachedAudioPipelineStatus,
    ...partial,
  };

  try {
    await chrome.storage.local.set({
      [AUDIO_PIPELINE_STATUS_STORAGE_KEY]: cachedAudioPipelineStatus,
    });
  } catch (error) {
    console.error("[SafeView] Failed to persist audio pipeline status:", error);
  }

  return getAudioPipelineStatus();
}

export async function loadAudioPipelineStatusFromStorage(): Promise<AudioPipelineStatus> {
  try {
    const stored = await chrome.storage.local.get(AUDIO_PIPELINE_STATUS_STORAGE_KEY);
    const raw = stored[AUDIO_PIPELINE_STATUS_STORAGE_KEY] as
      | AudioPipelineStatus
      | undefined;

    if (raw && typeof raw === "object") {
      cachedAudioPipelineStatus = {
        ...DEFAULT_AUDIO_PIPELINE_STATUS,
        ...raw,
      };
    }
  } catch (error) {
    console.error("[SafeView] Failed to load audio pipeline status:", error);
  }

  return getAudioPipelineStatus();
}

export async function markAudioPipelineStopped(
  lastError: string | null = null
): Promise<void> {
  await setAudioPipelineStatus({
    running: false,
    mode: null,
    tabId: null,
    lastStoppedAt: Date.now(),
    lastError,
  });
}
