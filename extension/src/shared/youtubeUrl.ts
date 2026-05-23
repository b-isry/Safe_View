// SafeView — youtubeUrl.ts
// Detect YouTube watch / Shorts video id changes for SPA navigation resets.

/**
 * Extract the YouTube content id from a watch, Shorts, or live URL.
 *
 * @param href - Page URL (defaults to location.href in content scripts).
 * @returns Video id string, or null when not on YouTube or id is unknown.
 */
export function getYouTubeWatchVideoId(href?: string): string | null {
  const target = href ?? (typeof location !== "undefined" ? location.href : "");

  if (!target) {
    return null;
  }

  try {
    const url = new URL(target);
    if (!/(^|\.)youtube\.com$/i.test(url.hostname)) {
      return null;
    }

    const watchId = url.searchParams.get("v");
    if (watchId) {
      return watchId;
    }

    const shortsMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shortsMatch?.[1]) {
      return shortsMatch[1];
    }

    const liveMatch = url.pathname.match(/^\/live\/([^/?#]+)/);
    if (liveMatch?.[1]) {
      return liveMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}
