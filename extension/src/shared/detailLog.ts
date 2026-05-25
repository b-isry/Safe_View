// SafeView — detailLog.ts
// Optional debug logging to backend / storage.

const DETAIL_LOG_STORAGE_KEY = "safeview_detail_log_enabled";

/**
 * True when verbose pipeline detail logging is enabled.
 */
export async function isDetailLogEnabled(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(DETAIL_LOG_STORAGE_KEY);
    return stored[DETAIL_LOG_STORAGE_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * Enable or disable verbose detail logging.
 */
export async function setDetailLogEnabled(enabled: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [DETAIL_LOG_STORAGE_KEY]: enabled });
  } catch {
    /* ignore */
  }
}

/**
 * Fire-and-forget detail log (no-op when disabled).
 */
export function detailLog(
  _location: string,
  _message: string,
  _data?: Record<string, unknown>,
  _hypothesisId?: string
): void {
  void isDetailLogEnabled().then((enabled) => {
    if (!enabled) {
      return;
    }
    console.debug("[SafeView][Detail]", _location, _message, _data ?? {});
  });
}
