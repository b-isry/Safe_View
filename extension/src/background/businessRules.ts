// SafeView — businessRules.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: BR-01 through BR-08 helpers for the extension service worker.

/** BR-01: minimum confidence threshold regardless of user sensitivity. */
export const CONFIDENCE_FLOOR = 0.75;

/** Default backend URL for local FastAPI during development. */
export const DEFAULT_BACKEND_URL = "http://localhost:8000";

/** Default user sensitivity (Medium stop). */
export const DEFAULT_SENSITIVITY = 0.75;

/** Sensitivity slider stops (options page). */
export const SENSITIVITY_LOW = 0.6;
export const SENSITIVITY_MEDIUM = 0.75;
export const SENSITIVITY_HIGH = 0.9;

/** Default profanity blacklist (BR-03) — user-editable in options. */
export const DEFAULT_PROFANITY_WORDS: string[] = [];

/** Categories with real inference models (stubs skipped to avoid 5× /analyze-image per frame). */
export const ACTIVE_MODEL_CATEGORIES: readonly string[] = ["nudity"];

/** BR-05: audio mute duration in milliseconds. */
export const MUTE_DURATION_MS = 1500;

/** Per-category filter toggles stored in chrome.storage.local. */
export interface CategoryToggles {
  nudity: boolean;
  violence: boolean;
  kissing: boolean;
  profanity: boolean;
  lgbtq: boolean;
}

/**
 * User settings persisted via chrome.storage.local (BR-04).
 */
export interface SafeViewSettings {
  protectionEnabled: boolean;
  backendUrl: string;
  sensitivity: number;
  categories: CategoryToggles;
  /** BR-03: editable profanity blacklist (subtitle / audio stub). */
  profanityWords: string[];
}

/** Storage keys for SafeView settings. */
export const SETTINGS_STORAGE_KEY = "safeview_settings";

/** Default settings applied when nothing is stored yet. */
export const DEFAULT_SETTINGS: SafeViewSettings = {
  protectionEnabled: true,
  backendUrl: DEFAULT_BACKEND_URL,
  sensitivity: DEFAULT_SENSITIVITY,
  categories: {
    nudity: true,
    violence: true,
    kissing: true,
    profanity: true,
    lgbtq: true,
  },
  profanityWords: [...DEFAULT_PROFANITY_WORDS],
};

/**
 * Compute BR-01 effective detection threshold.
 *
 * @param userSensitivity - User sensitivity from settings (0.0–1.0).
 * @returns max(0.75, userSensitivity).
 */
export function effectiveThreshold(userSensitivity: number): number {
  return Math.max(CONFIDENCE_FLOOR, userSensitivity);
}

/**
 * Decide whether confidence meets the BR-01 threshold.
 *
 * @param confidence - Model confidence from the backend (0.0–1.0).
 * @param userSensitivity - User sensitivity from settings.
 * @returns True when content should be blurred.
 */
export function shouldBlur(
  confidence: number,
  userSensitivity: number
): boolean {
  return confidence >= effectiveThreshold(userSensitivity);
}

/**
 * Load user settings from chrome.storage.local, falling back to defaults (BR-04).
 *
 * @returns SafeViewSettings merged with defaults.
 */
export async function loadSettings(): Promise<SafeViewSettings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const raw = stored[SETTINGS_STORAGE_KEY] as Partial<SafeViewSettings> | undefined;

    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }

    return {
      protectionEnabled:
        raw.protectionEnabled ?? DEFAULT_SETTINGS.protectionEnabled,
      backendUrl: raw.backendUrl ?? DEFAULT_SETTINGS.backendUrl,
      sensitivity: raw.sensitivity ?? DEFAULT_SETTINGS.sensitivity,
      categories: {
        ...DEFAULT_SETTINGS.categories,
        ...raw.categories,
      },
      profanityWords: Array.isArray(raw.profanityWords)
        ? raw.profanityWords.filter(
            (word): word is string =>
              typeof word === "string" && word.trim().length > 0
          )
        : [...DEFAULT_SETTINGS.profanityWords],
    };
  } catch (error) {
    console.error("[SafeView] Failed to load settings:", error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Return category keys that are enabled in the current settings.
 *
 * @param settings - Resolved SafeView settings.
 * @returns List of enabled category names for /analyze-image.
 */
export function getEnabledCategories(settings: SafeViewSettings): string[] {
  const activeSet = new Set<string>(ACTIVE_MODEL_CATEGORIES);
  return (Object.keys(settings.categories) as (keyof CategoryToggles)[]).filter(
    (key) => settings.categories[key] && activeSet.has(key)
  );
}

/**
 * Persist settings to chrome.storage.local (BR-04).
 *
 * @param settings - Full SafeView settings object.
 */
export async function saveSettings(settings: SafeViewSettings): Promise<void> {
  try {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: settings,
    });
  } catch (error) {
    console.error("[SafeView] Failed to save settings:", error);
  }
}
