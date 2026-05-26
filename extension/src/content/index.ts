// SafeView — index.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Content script entry — video sampling and blur on every page.
// Loaded via manifest content_scripts only — never assign raw strings to HTMLScriptElement.src.

import { initAudioMuteListener } from "./audioMonitor";
import { initBlurManager } from "./blurManager";
import { initElementAudioPipelineListener } from "./elementAudioPipeline";
import { startVideoMonitor } from "./videoMonitor";

/**
 * Bootstrap SafeView: monitor videos, send frames to service worker, apply blur on BLUR.
 */
function initContentScript(): void {
  initBlurManager();
  initAudioMuteListener();
  initElementAudioPipelineListener();
  startVideoMonitor();

  console.info(
    "[SafeView] Content script ready (v%s).",
    chrome.runtime.getManifest().version
  );
}

initContentScript();

void chrome.runtime
  .sendMessage({ type: "CONTENT_SCRIPT_READY" })
  .then(() => {
    console.log("[SafeView-Handshake] Connection established with Background.");
  })
  .catch(() => {
    console.warn(
      "[SafeView-Handshake] Background not reachable yet — will retry on next navigation."
    );
  });
