// SafeView — profanityStatus.ts
// Persist profanity pipeline debug state for the popup.

/** chrome.storage.local key for profanity pipeline debug state. */
export const PROFANITY_STATUS_STORAGE_KEY = "safeview_profanity_status";

/** Profanity pipeline snapshot for popup / diagnostics. */
export interface ProfanityStatus {
  profanityEnabled: boolean;
  pipelineRunning: boolean;
  lastChunkSentAt: number;
  lastDetectionAt: number;
  muteActive: boolean;
  whisperLoaded?: boolean;
}

const DEFAULT_PROFANITY_STATUS: ProfanityStatus = {
  profanityEnabled: false,
  pipelineRunning: false,
  lastChunkSentAt: 0,
  lastDetectionAt: 0,
  muteActive: false,
};

let cachedProfanityStatus: ProfanityStatus = { ...DEFAULT_PROFANITY_STATUS };

/**
 * Read the latest profanity status from memory.
 */
export function getProfanityStatus(): ProfanityStatus {
  return { ...cachedProfanityStatus };
}

/**
 * Merge partial updates and persist to chrome.storage.local.
 */
export async function updateProfanityStatus(
  partial: Partial<ProfanityStatus>
): Promise<void> {
  cachedProfanityStatus = {
    ...cachedProfanityStatus,
    ...partial,
  };

  try {
    await chrome.storage.local.set({
      [PROFANITY_STATUS_STORAGE_KEY]: cachedProfanityStatus,
    });
  } catch (error) {
    console.error("[SafeView] Failed to persist profanity status:", error);
  }
}

/**
 * Hydrate profanity status from storage (popup startup).
 */
export async function loadProfanityStatusFromStorage(): Promise<ProfanityStatus> {
  try {
    const stored = await chrome.storage.local.get(PROFANITY_STATUS_STORAGE_KEY);
    const raw = stored[PROFANITY_STATUS_STORAGE_KEY] as ProfanityStatus | undefined;

    if (raw && typeof raw === "object") {
      cachedProfanityStatus = {
        ...DEFAULT_PROFANITY_STATUS,
        ...raw,
      };
    }
  } catch (error) {
    console.error("[SafeView] Failed to load profanity status:", error);
  }

  return getProfanityStatus();
}

/**
 * Reset profanity status when the pipeline stops.
 */
export async function clearProfanityPipelineStatus(): Promise<void> {
  await updateProfanityStatus({
    pipelineRunning: false,
    muteActive: false,
  });
}
