// SafeView — aiClient.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: fetch() wrapper for localhost FastAPI POST /analyze-image.

import {
  DEFAULT_BACKEND_URL,
  DEFAULT_SENSITIVITY,
  loadSettings,
} from "./businessRules";

/** JSON body returned by the SafeView backend analyze-image endpoint. */
export interface AnalyzeImageResponse {
  category: string;
  detected: boolean;
  confidence: number;
  action: "BLUR" | "ALLOW";
  model_loaded: boolean;
}

/**
 * Result of analyzeImage — always resolves; never throws.
 */
export interface AnalyzeImageResult {
  response: AnalyzeImageResponse;
  backendOnline: boolean;
  fromFallback: boolean;
}

/**
 * Backend connectivity flag for popup status badge (BR-04 / fail-open).
 */
export interface BackendStatus {
  online: boolean;
  lastCheckedAt: number;
  lastError?: string;
}

/** chrome.storage.local key for backend online/offline status. */
export const BACKEND_STATUS_STORAGE_KEY = "safeview_backend_status";

const ACTION_ALLOW = "ALLOW" as const;

let cachedBackendStatus: BackendStatus = {
  online: true,
  lastCheckedAt: 0,
};

/**
 * Read the current backend online/offline status (in-memory cache).
 *
 * @returns Latest BackendStatus snapshot.
 */
export function getBackendStatus(): BackendStatus {
  return { ...cachedBackendStatus };
}

/**
 * Persist backend status to chrome.storage.local for UI consumers.
 *
 * @param status - Connectivity snapshot to store.
 */
async function persistBackendStatus(status: BackendStatus): Promise<void> {
  cachedBackendStatus = status;

  try {
    await chrome.storage.local.set({
      [BACKEND_STATUS_STORAGE_KEY]: status,
    });
  } catch (error) {
    console.error("[SafeView] Failed to persist backend status:", error);
  }
}

/**
 * Mark backend offline with an optional error message.
 *
 * @param errorMessage - Human-readable failure reason (not frame data).
 */
async function markBackendOffline(errorMessage?: string): Promise<void> {
  await persistBackendStatus({
    online: false,
    lastCheckedAt: Date.now(),
    lastError: errorMessage,
  });
}

/**
 * Mark backend online after a successful request.
 */
async function markBackendOnline(): Promise<void> {
  await persistBackendStatus({
    online: true,
    lastCheckedAt: Date.now(),
  });
}

/**
 * Fail-open response when the backend is unreachable or returns an error.
 *
 * @param category - Requested detection category.
 * @returns Safe ALLOW result with zero confidence.
 */
function buildSafeDefaultResponse(category: string): AnalyzeImageResponse {
  return {
    category,
    detected: false,
    confidence: 0,
    action: ACTION_ALLOW,
    model_loaded: false,
  };
}

/**
 * Resolve backend base URL from chrome.storage.local (BR-04).
 *
 * @returns Backend URL string.
 */
async function resolveBackendUrl(): Promise<string> {
  try {
    const settings = await loadSettings();
    return settings.backendUrl || DEFAULT_BACKEND_URL;
  } catch (error) {
    console.error("[SafeView] Failed to read backend URL from storage:", error);
    return DEFAULT_BACKEND_URL;
  }
}

/**
 * POST a JPEG frame to /analyze-image. Reads backend URL from storage.
 *
 * Never throws — on failure returns a safe ALLOW default and sets backend offline.
 *
 * @param frame - JPEG blob from the content script (never logged).
 * @param sensitivity - User sensitivity (0.0–1.0).
 * @param category - Detection category to run.
 * @returns AnalyzeImageResult with response and connectivity flags.
 */
export async function analyzeImage(
  frame: Blob,
  sensitivity: number = DEFAULT_SENSITIVITY,
  category: string = "nudity"
): Promise<AnalyzeImageResult> {
  const safeDefault = buildSafeDefaultResponse(category);

  try {
    const backendUrl = await resolveBackendUrl();
    const baseUrl = backendUrl.replace(/\/$/, "");
    const endpoint = `${baseUrl}/analyze-image`;

    const formData = new FormData();
    formData.append("frame", frame, "frame.jpg");
    formData.append("sensitivity", String(sensitivity));
    formData.append("category", category);

    let response: Response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        body: formData,
      });
    } catch (error) {
      const message = `Backend unreachable at ${endpoint}`;
      console.warn(`[SafeView] ${message}`);
      await markBackendOffline(message);
      return {
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      };
    }

    if (!response.ok) {
      const message = `Backend returned HTTP ${response.status}`;
      console.warn(`[SafeView] ${message}`);
      await markBackendOffline(message);
      return {
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      };
    }

    let body: AnalyzeImageResponse;

    try {
      body = (await response.json()) as AnalyzeImageResponse;
    } catch (error) {
      const message = "Invalid JSON from analyze-image";
      console.warn(`[SafeView] ${message}`);
      await markBackendOffline(message);
      return {
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      };
    }

    if (
      typeof body.confidence !== "number" ||
      typeof body.detected !== "boolean" ||
      typeof body.action !== "string"
    ) {
      const message = "Invalid analyze-image response shape";
      console.warn(`[SafeView] ${message}`);
      await markBackendOffline(message);
      return {
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      };
    }

    await markBackendOnline();

    return {
      response: {
        category: body.category ?? category,
        detected: body.detected,
        confidence: body.confidence,
        action: body.action === "BLUR" ? "BLUR" : ACTION_ALLOW,
        model_loaded: Boolean(body.model_loaded),
      },
      backendOnline: true,
      fromFallback: false,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected analyze-image error";
    console.error("[SafeView] analyzeImage failed:", message);
    await markBackendOffline(message);
    return {
      response: safeDefault,
      backendOnline: false,
      fromFallback: true,
    };
  }
}

/**
 * GET /health against a specific backend base URL.
 *
 * @param backendUrl - Base URL to probe (e.g. from options field).
 * @param updateStatusFlag - When true, persist online/offline to storage.
 * @returns True when the backend responds with status ok.
 */
export async function checkBackendHealthAt(
  backendUrl: string,
  updateStatusFlag = true
): Promise<boolean> {
  try {
    const baseUrl = backendUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/health`);

    if (!response.ok) {
      if (updateStatusFlag) {
        await markBackendOffline(`Health check HTTP ${response.status}`);
      }
      return false;
    }

    const body = (await response.json()) as { status?: string };

    if (body.status === "ok") {
      if (updateStatusFlag) {
        await markBackendOnline();
      }
      return true;
    }

    if (updateStatusFlag) {
      await markBackendOffline("Health check status not ok");
    }
    return false;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Health check failed";
    if (updateStatusFlag) {
      await markBackendOffline(message);
    }
    return false;
  }
}

/**
 * GET /health using backend URL from chrome.storage.local.
 *
 * @returns True when the backend responds with status ok.
 */
export async function checkBackendHealth(): Promise<boolean> {
  const backendUrl = await resolveBackendUrl();
  return checkBackendHealthAt(backendUrl, true);
}

/**
 * Hydrate in-memory backend status from chrome.storage.local on worker startup.
 */
export async function loadBackendStatusFromStorage(): Promise<BackendStatus> {
  try {
    const stored = await chrome.storage.local.get(BACKEND_STATUS_STORAGE_KEY);
    const raw = stored[BACKEND_STATUS_STORAGE_KEY] as BackendStatus | undefined;

    if (raw && typeof raw.online === "boolean") {
      cachedBackendStatus = {
        online: raw.online,
        lastCheckedAt: raw.lastCheckedAt ?? 0,
        lastError: raw.lastError,
      };
    }
  } catch (error) {
    console.error("[SafeView] Failed to load backend status:", error);
  }

  return getBackendStatus();
}
