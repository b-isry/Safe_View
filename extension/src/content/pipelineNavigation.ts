// SafeView — pipelineNavigation.ts
// Reset processing gain and rebind element audio when YouTube SPA navigation changes videos.

import { getYouTubeWatchVideoId } from "../shared/youtubeUrl";
import { resetBlurStateForNavigation } from "./blurManager";
import { clearProcessingMutesOnNavigation } from "./audioMonitor";
import { loadSettings } from "../background/businessRules";
import { isProfanityProtectionActive } from "../shared/settingsMessages";
import * as elementAudioPipeline from "./elementAudioPipeline";
import { resetVideoCaptureForNavigation } from "./videoMonitor";

/** Content → service worker: YouTube navigation / watch id changed. */
export const MESSAGE_ACTION_PIPELINE_NAVIGATION = "PIPELINE_NAVIGATION";

let lastYouTubeWatchVideoId: string | null = null;

/**
 * True when the YouTube watch id changed (e.g. v=2 → v=5).
 *
 * @param href - Optional URL override for tests.
 */
export function detectYouTubeWatchIdChange(href?: string): boolean {
  const nextId = getYouTubeWatchVideoId(href);
  if (!nextId) {
    return false;
  }

  if (lastYouTubeWatchVideoId === nextId) {
    return false;
  }

  lastYouTubeWatchVideoId = nextId;
  return true;
}

/**
 * Seed the last seen watch id without triggering a reset (initial page load).
 */
export function seedYouTubeWatchVideoId(href?: string): void {
  lastYouTubeWatchVideoId = getYouTubeWatchVideoId(href);
}

/**
 * Force processing-path gain to 1.0 and notify the service worker to reset offscreen gain.
 *
 * @param reason - Diagnostic label (navigation-finish, new-video, url-change).
 */
export function handlePipelineNavigationBoundary(reason: string): void {
  resetBlurStateForNavigation(reason);
  resetVideoCaptureForNavigation(reason);

  clearProcessingMutesOnNavigation();

  void (async () => {
    elementAudioPipeline.resetElementPipelineGain();

    const settings = await loadSettings();
    if (!isProfanityProtectionActive(settings)) {
      elementAudioPipeline.stopElementAudioFallback();
      return;
    }

    const elementTabId = elementAudioPipeline.getElementPipelineTabId();
    if (elementTabId !== undefined) {
      await elementAudioPipeline.startElementAudioFallback(elementTabId);
    }
  })();

  void chrome.runtime
    .sendMessage({
      action: MESSAGE_ACTION_PIPELINE_NAVIGATION,
      reason,
      youtubeVideoId: lastYouTubeWatchVideoId ?? undefined,
    })
    .catch(() => {});

  console.info("[SafeView] Pipeline navigation reset (%s).", reason);
}

/**
 * Run a navigation reset when the YouTube watch id changed.
 *
 * @param reason - Diagnostic label.
 * @param href - Optional URL override.
 */
export function onYouTubeWatchIdBoundary(
  reason: string,
  href?: string
): void {
  if (detectYouTubeWatchIdChange(href)) {
    handlePipelineNavigationBoundary(reason);
  }
}
