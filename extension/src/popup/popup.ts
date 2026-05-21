// SafeView — popup.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Extension popup UI — protection toggle, status dot, filters, backend status.

import {
  BACKEND_STATUS_STORAGE_KEY,
  checkBackendHealth,
  getBackendStatus,
  loadBackendStatusFromStorage,
  type BackendStatus,
} from "../background/aiClient";
import {
  getEnabledCategories,
  loadSettings,
  saveSettings,
  SETTINGS_STORAGE_KEY,
  type SafeViewSettings,
} from "../background/businessRules";

/** Visual status for the popup indicator dot. */
type StatusDotState = "green" | "red" | "grey";

const statusDot = document.getElementById("statusDot") as HTMLSpanElement;
const statusLabel = document.getElementById("statusLabel") as HTMLParagraphElement;
const protectionToggle = document.getElementById(
  "protectionToggle"
) as HTMLInputElement;
const filterCountEl = document.getElementById("filterCount") as HTMLSpanElement;
const backendStatusEl = document.getElementById(
  "backendStatus"
) as HTMLSpanElement;
const openOptionsButton = document.getElementById(
  "openOptions"
) as HTMLButtonElement;

/**
 * Count enabled category filters from settings.
 *
 * @param settings - Current SafeView settings.
 * @returns Number of active filters.
 */
function countActiveFilters(settings: SafeViewSettings): number {
  return getEnabledCategories(settings).length;
}

/**
 * Resolve popup status dot state from protection and backend flags.
 *
 * @param protectionEnabled - Whether protection is on.
 * @param backendOnline - Whether the AI backend is reachable.
 * @returns green (monitoring), red (offline), or grey (idle).
 */
function resolveStatusDotState(
  protectionEnabled: boolean,
  backendOnline: boolean
): StatusDotState {
  if (!protectionEnabled) {
    return "grey";
  }

  if (!backendOnline) {
    return "red";
  }

  return "green";
}

/**
 * Apply status dot CSS classes and accessible label.
 *
 * @param state - green, red, or grey.
 */
function renderStatusDot(state: StatusDotState): void {
  statusDot.classList.remove(
    "status-dot--green",
    "status-dot--red",
    "status-dot--grey",
    "status-dot--pulse"
  );

  if (state === "green") {
    statusDot.classList.add("status-dot--green", "status-dot--pulse");
    statusLabel.textContent = "Monitoring";
    statusDot.setAttribute("aria-label", "Status: monitoring");
    return;
  }

  if (state === "red") {
    statusDot.classList.add("status-dot--red");
    statusLabel.textContent = "Backend offline";
    statusDot.setAttribute("aria-label", "Status: backend offline");
    return;
  }

  statusDot.classList.add("status-dot--grey");
  statusLabel.textContent = "Idle";
  statusDot.setAttribute("aria-label", "Status: idle");
}

/**
 * Update backend status text in the popup card.
 *
 * @param backendStatus - Connectivity snapshot.
 */
function renderBackendStatusText(backendStatus: BackendStatus): void {
  backendStatusEl.classList.remove("is-online", "is-offline");

  if (backendStatus.online) {
    backendStatusEl.textContent = "Connected";
    backendStatusEl.classList.add("is-online");
    return;
  }

  backendStatusEl.textContent = "Offline";
  backendStatusEl.classList.add("is-offline");
}

/**
 * Refresh all popup UI from storage and optional health check.
 *
 * @param runHealthCheck - When true, ping GET /health before rendering.
 */
async function refreshPopup(runHealthCheck: boolean): Promise<void> {
  try {
    const settings = await loadSettings();

    if (runHealthCheck) {
      await checkBackendHealth();
    } else {
      await loadBackendStatusFromStorage();
    }

    const backendStatus = getBackendStatus();
    const dotState = resolveStatusDotState(
      settings.protectionEnabled,
      backendStatus.online
    );

    protectionToggle.checked = settings.protectionEnabled;
    filterCountEl.textContent = String(countActiveFilters(settings));
    renderStatusDot(dotState);
    renderBackendStatusText(backendStatus);
  } catch (error) {
    console.error("[SafeView] Popup refresh failed:", error);
    renderStatusDot("red");
    backendStatusEl.textContent = "Offline";
    backendStatusEl.classList.add("is-offline");
  }
}

/**
 * Handle protection toggle changes and persist immediately.
 */
async function handleProtectionToggle(): Promise<void> {
  try {
    const settings = await loadSettings();
    settings.protectionEnabled = protectionToggle.checked;
    await saveSettings(settings);
    await refreshPopup(false);
  } catch (error) {
    console.error("[SafeView] Protection toggle failed:", error);
  }
}

/**
 * Open the extension options page in a new tab.
 */
function handleOpenOptions(): void {
  try {
    void chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error("[SafeView] Could not open options page:", error);
  }
}

/**
 * Re-render popup when settings or backend status change in storage.
 */
function handleStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
): void {
  if (areaName !== "local") {
    return;
  }

  if (
    changes[SETTINGS_STORAGE_KEY] !== undefined ||
    changes[BACKEND_STATUS_STORAGE_KEY] !== undefined
  ) {
    void refreshPopup(false);
  }
}

/**
 * Bootstrap popup listeners and initial render.
 */
function initPopup(): void {
  protectionToggle.addEventListener("change", () => {
    void handleProtectionToggle();
  });

  openOptionsButton.addEventListener("click", handleOpenOptions);
  chrome.storage.onChanged.addListener(handleStorageChanged);

  void refreshPopup(true);
}

initPopup();
