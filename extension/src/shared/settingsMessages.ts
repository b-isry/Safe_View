// SafeView — settingsMessages.ts
// Broadcast SETTINGS_UPDATED to the active tab and service worker after saves.

import {
  loadSettings,
  SETTINGS_STORAGE_KEY,
  type SafeViewSettings,
} from "../background/businessRules";

/** Popup / options / background → content script & service worker. */
export const MESSAGE_ACTION_SETTINGS_UPDATED = "SETTINGS_UPDATED";

/**
 * True when full-video nudity protection should be active on the current page.
 */
export function isNudityProtectionActive(settings: SafeViewSettings): boolean {
  return settings.protectionEnabled && settings.categories.nudity;
}

/**
 * True when full-video violence protection should be active on the current page.
 */
export function isViolenceProtectionActive(settings: SafeViewSettings): boolean {
  return settings.protectionEnabled && settings.categories.violence;
}

/**
 * True when any frame-based vision category (nudity or violence) is enabled.
 */
export function isFrameProtectionActive(settings: SafeViewSettings): boolean {
  return isNudityProtectionActive(settings) || isViolenceProtectionActive(settings);
}

/**
 * True when profanity audio pipeline should run on the active page.
 */
export function isProfanityProtectionActive(settings: SafeViewSettings): boolean {
  return settings.protectionEnabled && settings.categories.profanity;
}

/**
 * Notify the service worker and active tab that settings changed (no page refresh).
 *
 * @param reason - Diagnostic label (category_toggle, protection_on, etc.).
 */
export async function notifySettingsUpdated(reason: string): Promise<void> {
  const payload = {
    action: MESSAGE_ACTION_SETTINGS_UPDATED,
    reason,
  };

  void chrome.runtime.sendMessage(payload).catch(() => {
    /* Service worker may be asleep; storage.onChanged is the backup path. */
  });

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const tabId = tab?.id;
    if (tabId === undefined) {
      return;
    }

    await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    /* Content script not ready on chrome:// or restricted pages — storage listener handles it. */
    console.info(
      "[SafeView] SETTINGS_UPDATED not delivered to tab (%s); content script will pick up storage change.",
      reason
    );
  }
}

/**
 * Reload settings from storage (content script helper).
 */
export async function reloadSettingsFromStorage(): Promise<SafeViewSettings> {
  return loadSettings();
}

export { SETTINGS_STORAGE_KEY };
