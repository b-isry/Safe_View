// SafeView — index.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Content script entry — video sampling and blur on every page.

import { initBlurManager } from "./blurManager";
import { startVideoMonitor } from "./videoMonitor";

/**
 * Bootstrap SafeView: monitor videos, send frames to service worker, apply blur on BLUR.
 */
function initContentScript(): void {
  initBlurManager();
  startVideoMonitor();

  console.info(
    "[SafeView] Content script ready (v%s).",
    chrome.runtime.getManifest().version
  );
}

initContentScript();
