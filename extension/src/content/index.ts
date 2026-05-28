// SafeView — index.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Content script entry — video sampling and blur on every page.
// Loaded via manifest content_scripts only — never assign raw strings to HTMLScriptElement.src.

import { ensureVisionProtectionDefaults } from "../background/businessRules";
import { initAudioMuteListener } from "./audioMonitor";
import { initBlurManager } from "./blurManager";
import { initElementAudioPipelineListener } from "./elementAudioPipeline";
import { startStaticImageMonitor } from "./imageMonitor";
import { startVideoMonitor } from "./videoMonitor";
import { MESSAGE_ACTION_SETTINGS_UPDATED } from "../shared/settingsMessages";

function requestDefaultProtectionStart(reason: string): void {
  void chrome.runtime
    .sendMessage({
      action: MESSAGE_ACTION_SETTINGS_UPDATED,
      reason,
    })
    .catch(() => {
      /* The service worker may be waking up; storage migration still keeps defaults enabled. */
    });
}

/**
 * Bootstrap SafeView: monitor videos, send frames to service worker, apply blur on BLUR.
 */
function initContentScript(): void {
  console.info(
    "[SafeView] Content script boot on %s (v%s)",
    location.href,
    chrome.runtime.getManifest().version
  );

  initBlurManager();
  initAudioMuteListener();
  initElementAudioPipelineListener();
  startVideoMonitor();
  startStaticImageMonitor();

  console.info(
    "[SafeView] Content script ready (video + images) — use this page's DevTools Console for [SafeView] logs."
  );

  requestDefaultProtectionStart("content_boot_auto_start");
  window.setTimeout(() => {
    requestDefaultProtectionStart("content_boot_auto_start_retry");
  }, 1500);
}

void ensureVisionProtectionDefaults()
  .then(() => {
    try {
      initContentScript();
    } catch (error) {
      console.error("[SafeView] Content script failed to start:", error);
    }
  })
  .catch((error) => {
    console.error("[SafeView] Failed to apply default settings:", error);
    try {
      initContentScript();
    } catch (bootError) {
      console.error("[SafeView] Content script failed to start:", bootError);
    }
  });
