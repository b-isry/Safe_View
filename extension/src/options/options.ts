// SafeView — options.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Options page — category toggles, sensitivity, backend URL, profanity list.

import { checkBackendHealthAt } from "../background/aiClient";
import {
  CONFIDENCE_FLOOR,
  DEFAULT_SETTINGS,
  effectiveThreshold,
  loadSettings,
  saveSettings,
  SENSITIVITY_HIGH,
  SENSITIVITY_LOW,
  SENSITIVITY_MEDIUM,
  type CategoryToggles,
  type SafeViewSettings,
} from "../background/businessRules";
import { notifySettingsUpdated } from "../shared/settingsMessages";

/** Category checkbox metadata for the options UI. */
const CATEGORY_FIELDS: { key: keyof CategoryToggles; label: string }[] = [
  { key: "nudity", label: "Nudity" },
  { key: "violence", label: "Violence" },
  { key: "kissing", label: "Kissing / Romantic" },
  { key: "profanity", label: "Profanity" },
  { key: "lgbtq", label: "LGBTQ+ Themes" },
];

const SENSITIVITY_STOPS = [
  { index: 0, value: SENSITIVITY_LOW, label: "Low" },
  { index: 1, value: SENSITIVITY_MEDIUM, label: "Medium" },
  { index: 2, value: SENSITIVITY_HIGH, label: "High" },
] as const;

let currentSettings: SafeViewSettings = { ...DEFAULT_SETTINGS };

const sensitivitySlider = document.getElementById(
  "sensitivitySlider"
) as HTMLInputElement;
const sensitivityValue = document.getElementById(
  "sensitivityValue"
) as HTMLParagraphElement;
const backendUrlInput = document.getElementById("backendUrl") as HTMLInputElement;
const testConnectionButton = document.getElementById(
  "testConnection"
) as HTMLButtonElement;
const connectionStatus = document.getElementById(
  "connectionStatus"
) as HTMLSpanElement;
const profanityInput = document.getElementById(
  "profanityInput"
) as HTMLInputElement;
const addProfanityWordButton = document.getElementById(
  "addProfanityWord"
) as HTMLButtonElement;
const profanityList = document.getElementById(
  "profanityList"
) as HTMLUListElement;
const resetDefaultsButton = document.getElementById(
  "resetDefaults"
) as HTMLButtonElement;
const saveStatus = document.getElementById("saveStatus") as HTMLParagraphElement;

const categoryCheckboxes = CATEGORY_FIELDS.map(({ key }) =>
  document.querySelector(
    `[data-category="${key}"]`
  ) as HTMLInputElement
);

/**
 * Map sensitivity float to slider index 0–2.
 *
 * @param sensitivity - Stored sensitivity value.
 * @returns Nearest slider stop index.
 */
function sensitivityToSliderIndex(sensitivity: number): number {
  const match = SENSITIVITY_STOPS.reduce((best, stop) => {
    const bestDelta = Math.abs(SENSITIVITY_STOPS[best].value - sensitivity);
    const stopDelta = Math.abs(stop.value - sensitivity);
    return stopDelta < bestDelta ? stop.index : best;
  }, 0);
  return match;
}

/**
 * Map slider index to sensitivity float.
 *
 * @param index - Slider value 0, 1, or 2.
 * @returns Sensitivity float for storage.
 */
function sliderIndexToSensitivity(index: number): number {
  const stop = SENSITIVITY_STOPS.find((item) => item.index === index);
  return stop?.value ?? SENSITIVITY_MEDIUM;
}

/**
 * Update sensitivity hint text under the slider.
 *
 * @param sensitivity - Current sensitivity value.
 */
function updateSensitivityHint(sensitivity: number): void {
  const stop = SENSITIVITY_STOPS.find(
    (item) => Math.abs(item.value - sensitivity) < 0.001
  );
  const label = stop?.label ?? "Custom";
  const effective = effectiveThreshold(sensitivity);
  sensitivityValue.textContent = `${label} — effective floor ${effective.toFixed(2)} (BR-01, min ${CONFIDENCE_FLOOR})`;
}

/**
 * Flash a brief saved confirmation message.
 */
function showSavedStatus(): void {
  saveStatus.textContent = "Saved";
  window.setTimeout(() => {
    if (saveStatus.textContent === "Saved") {
      saveStatus.textContent = "";
    }
  }, 1200);
}

/**
 * Persist current in-memory settings immediately (BR-04).
 */
async function persistSettings(): Promise<void> {
  await saveSettings(currentSettings);
  showSavedStatus();
  await notifySettingsUpdated("options_save");
}

/**
 * Apply loaded settings to all form controls.
 *
 * @param settings - Settings from chrome.storage.local.
 */
function renderForm(settings: SafeViewSettings): void {
  currentSettings = {
    ...settings,
    categories: { ...settings.categories },
    profanityWords: [...settings.profanityWords],
  };

  categoryCheckboxes.forEach((checkbox, index) => {
    const key = CATEGORY_FIELDS[index].key;
    checkbox.checked = currentSettings.categories[key];
  });

  const sliderIndex = sensitivityToSliderIndex(currentSettings.sensitivity);
  sensitivitySlider.value = String(sliderIndex);
  updateSensitivityHint(currentSettings.sensitivity);

  backendUrlInput.value = currentSettings.backendUrl;
  renderProfanityList();
}

/**
 * Render the profanity word list with remove buttons.
 */
function renderProfanityList(): void {
  profanityList.innerHTML = "";
  profanityList.classList.toggle(
    "options__word-list--empty",
    currentSettings.profanityWords.length === 0
  );

  currentSettings.profanityWords.forEach((word, index) => {
    const item = document.createElement("li");
    item.className = "options__word-item";

    const text = document.createElement("span");
    text.className = "options__word-text";
    text.textContent = word;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "options__word-remove";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      void removeProfanityWord(index);
    });

    item.appendChild(text);
    item.appendChild(removeButton);
    profanityList.appendChild(item);
  });
}

/**
 * Handle category checkbox change — save immediately.
 */
async function handleCategoryChange(): Promise<void> {
  categoryCheckboxes.forEach((checkbox, index) => {
    const key = CATEGORY_FIELDS[index].key;
    currentSettings.categories[key] = checkbox.checked;
  });
  await persistSettings();
}

/**
 * Handle sensitivity slider change — save immediately.
 */
async function handleSensitivityChange(): Promise<void> {
  const index = Number(sensitivitySlider.value);
  currentSettings.sensitivity = sliderIndexToSensitivity(index);
  updateSensitivityHint(currentSettings.sensitivity);
  await persistSettings();
}

/**
 * Handle backend URL input — save on change and blur.
 */
async function handleBackendUrlChange(): Promise<void> {
  currentSettings.backendUrl = backendUrlInput.value.trim();
  await persistSettings();
}

/**
 * Test backend connectivity using the URL in the input field.
 */
async function handleTestConnection(): Promise<void> {
  const url = backendUrlInput.value.trim();

  if (!url) {
    connectionStatus.textContent = "Enter a backend URL first.";
    connectionStatus.className = "options__status is-error";
    return;
  }

  connectionStatus.textContent = "Testing…";
  connectionStatus.className = "options__status";

  currentSettings.backendUrl = url;
  await persistSettings();

  const online = await checkBackendHealthAt(url, true);

  if (online) {
    connectionStatus.textContent = "Connected";
    connectionStatus.className = "options__status is-success";
    return;
  }

  connectionStatus.textContent = "Offline — check URL and server";
  connectionStatus.className = "options__status is-error";
}

/**
 * Add a word to the profanity blacklist (BR-03).
 */
async function addProfanityWord(): Promise<void> {
  const word = profanityInput.value.trim().toLowerCase();

  if (!word) {
    return;
  }

  if (currentSettings.profanityWords.includes(word)) {
    profanityInput.value = "";
    return;
  }

  currentSettings.profanityWords = [...currentSettings.profanityWords, word].sort();
  profanityInput.value = "";
  renderProfanityList();
  await persistSettings();
}

/**
 * Remove a word from the profanity list by index.
 *
 * @param index - Index in profanityWords array.
 */
async function removeProfanityWord(index: number): Promise<void> {
  currentSettings.profanityWords = currentSettings.profanityWords.filter(
    (_, itemIndex) => itemIndex !== index
  );
  renderProfanityList();
  await persistSettings();
}

/**
 * Restore all settings to project defaults.
 */
async function handleResetDefaults(): Promise<void> {
  currentSettings = {
    ...DEFAULT_SETTINGS,
    categories: { ...DEFAULT_SETTINGS.categories },
    profanityWords: [...DEFAULT_SETTINGS.profanityWords],
  };

  renderForm(currentSettings);
  await persistSettings();

  connectionStatus.textContent = "";
  connectionStatus.className = "options__status";
}

/**
 * Bootstrap options page listeners and initial load.
 */
async function initOptions(): Promise<void> {
  const settings = await loadSettings();
  renderForm(settings);

  categoryCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      void handleCategoryChange();
    });
  });

  sensitivitySlider.addEventListener("input", () => {
    updateSensitivityHint(sliderIndexToSensitivity(Number(sensitivitySlider.value)));
  });

  sensitivitySlider.addEventListener("change", () => {
    void handleSensitivityChange();
  });

  backendUrlInput.addEventListener("change", () => {
    void handleBackendUrlChange();
  });

  backendUrlInput.addEventListener("blur", () => {
    void handleBackendUrlChange();
  });

  testConnectionButton.addEventListener("click", () => {
    void handleTestConnection();
  });

  addProfanityWordButton.addEventListener("click", () => {
    void addProfanityWord();
  });

  profanityInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void addProfanityWord();
    }
  });

  resetDefaultsButton.addEventListener("click", () => {
    void handleResetDefaults();
  });
}

void initOptions();
