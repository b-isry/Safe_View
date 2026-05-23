// SafeView — aiClient.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: fetch() wrapper for localhost FastAPI POST /analyze-image.

import {
  DEFAULT_BACKEND_URL,
  DEFAULT_SENSITIVITY,
  MUTE_DURATION_MS,
  getCachedSettings,
  loadSettings,
} from "./businessRules";

/** JSON body returned by the SafeView backend POST /analyze-audio endpoint. */
export interface AnalyzeAudioResponse {
  detected: boolean;
  action: "MUTE" | "ALLOW";
  duration_ms: number;
  whisper_loaded: boolean;
  confidence: number;
}

/**
 * Result of analyzeAudio — always resolves; never throws.
 */
export interface AnalyzeAudioResult {
  response: AnalyzeAudioResponse;
  backendOnline: boolean;
  fromFallback: boolean;
}

/** JSON body returned by the SafeView backend analyze-image endpoint. */
export interface AnalyzeImageResponse {
  category: string;
  detected: boolean;
  confidence: number;
  action: "BLUR" | "ALLOW";
  /** Argmax class from the model (independent of user sensitivity threshold). */
  label?: "NSFW" | "SFW";
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
const ACTION_MUTE = "MUTE" as const;

/**
 * Fail-open response when /analyze-audio is unreachable or invalid.
 *
 * @returns Safe ALLOW result with BR-05 duration_ms.
 */
function buildSafeAudioDefaultResponse(): AnalyzeAudioResponse {
  return {
    detected: false,
    action: ACTION_ALLOW,
    duration_ms: MUTE_DURATION_MS,
    whisper_loaded: false,
    confidence: 0,
  };
}

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
function resolveBackendUrl(): string {
  return getCachedSettings().backendUrl || DEFAULT_BACKEND_URL;
}

/**
 * Minimal fields extracted from an analyze-image response body.
 */
export interface ParsedAnalyzeImageBody {
  label?: "NSFW" | "SFW";
  score: number;
  category?: string;
  detected?: boolean;
  action?: string;
  model_loaded?: boolean;
}

/**
 * Strip ```json ... ``` (or plain ```) markdown fences when present.
 *
 * @param text - Raw HTTP response text.
 * @returns Inner payload or trimmed text.
 */
function stripMarkdownJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Extract the first balanced `{ ... }` object from surrounding text.
 *
 * @param text - Raw or partially cleaned response text.
 * @returns JSON object substring, or null when none found.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Parse analyze-image response text (handles fences and leading/trailing prose).
 *
 * @param rawText - Full response body as text.
 * @returns Parsed label/score and optional API fields, or null when unparseable.
 */
export function parseAnalyzeImageResponseText(
  rawText: string
): ParsedAnalyzeImageBody | null {
  const stripped = stripMarkdownJsonFences(rawText);
  const embedded = extractFirstJsonObject(stripped);
  const candidates = [stripped, embedded].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    try {
      const body = JSON.parse(candidate) as Record<string, unknown>;
      const score =
        typeof body.score === "number"
          ? body.score
          : typeof body.confidence === "number"
            ? body.confidence
            : null;

      if (score === null) {
        continue;
      }

      const rawLabel = body.label;
      const label =
        rawLabel === "NSFW" || rawLabel === "SFW" ? rawLabel : undefined;

      return {
        label,
        score,
        category: typeof body.category === "string" ? body.category : undefined,
        detected:
          typeof body.detected === "boolean" ? body.detected : undefined,
        action: typeof body.action === "string" ? body.action : undefined,
        model_loaded:
          typeof body.model_loaded === "boolean" ? body.model_loaded : undefined,
      };
    } catch {
      // try next candidate
    }
  }

  console.error("[SafeView] Unparseable analyze-image response:", rawText);
  console.warn(
    "[SafeView][PARSE ERROR] raw response logged above — frame skipped"
  );
  return null;
}

/**
 * POST a JPEG frame to /analyze-image. Reads backend URL from storage.
 *
 * Never throws — on failure returns a safe ALLOW default and sets backend offline.
 *
 * @param frame - JPEG blob from the content script (never logged).
 * @param sensitivity - User sensitivity (0.0–1.0).
 * @param category - Detection category to run.
 * @returns AnalyzeImageResult with response and connectivity flags, or null when the body is unparseable (frame skipped).
 */
export async function analyzeImage(
  frame: Blob,
  sensitivity: number = DEFAULT_SENSITIVITY,
  category: string = "nudity",
  signal?: AbortSignal
): Promise<AnalyzeImageResult | null> {
  const safeDefault = buildSafeDefaultResponse(category);

  if (signal?.aborted) {
    throw new DOMException("Frame analysis aborted", "AbortError");
  }

  try {
    const backendUrl = resolveBackendUrl();
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
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

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

    const rawText = await response.text();
    console.log("[SafeView] Raw response:", rawText);

    const parsed = parseAnalyzeImageResponseText(rawText);
    if (parsed === null) {
      return null;
    }

    if (
      typeof parsed.detected !== "boolean" ||
      typeof parsed.action !== "string"
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

    const rawLabel = parsed.label;
    const label =
      rawLabel === "NSFW" || rawLabel === "SFW" ? rawLabel : undefined;

    return {
      response: {
        category: parsed.category ?? category,
        detected: parsed.detected,
        confidence: parsed.score,
        action: parsed.action === "BLUR" ? "BLUR" : ACTION_ALLOW,
        label,
        model_loaded: Boolean(parsed.model_loaded),
      },
      backendOnline: true,
      fromFallback: false,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

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
 * POST WebM audio to /analyze-audio. Reads backend URL from storage.
 *
 * Never throws — on failure returns a safe ALLOW default.
 *
 * @param audio - WebM blob from MediaRecorder (never logged).
 * @param language - Whisper language code (en | am).
 * @param sensitivity - User sensitivity (unused by backend profanity; kept for API).
 * @returns AnalyzeAudioResult with response and connectivity flags.
 */
export async function analyzeAudio(
  audio: Blob,
  language: string,
  sensitivity: number = DEFAULT_SENSITIVITY
): Promise<AnalyzeAudioResult> {
  const safeDefault = buildSafeAudioDefaultResponse();

  try {
    const backendUrl = resolveBackendUrl();
    const baseUrl = backendUrl.replace(/\/$/, "");
    const endpoint = `${baseUrl}/analyze-audio`;

    const formData = new FormData();
    formData.append("audio_chunk", audio, "chunk.webm");
    formData.append("language", language);
    formData.append("sensitivity", String(sensitivity));

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

    let body: Record<string, unknown>;

    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      const message = "Invalid JSON from analyze-audio";
      console.warn(`[SafeView] ${message}`);
      await markBackendOffline(message);
      return {
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      };
    }

    if (
      typeof body.detected !== "boolean" ||
      typeof body.action !== "string" ||
      typeof body.duration_ms !== "number"
    ) {
      const message = "Invalid analyze-audio response shape";
      console.warn(`[SafeView] ${message}`);
      await markBackendOffline(message);
      return {
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      };
    }

    await markBackendOnline();

    const detected = Boolean(body.detected);
    const action = body.action === ACTION_MUTE ? ACTION_MUTE : ACTION_ALLOW;
    const duration_ms =
      typeof body.duration_ms === "number" ? body.duration_ms : MUTE_DURATION_MS;
    const whisper_loaded = Boolean(body.whisper_loaded);
    const confidence =
      typeof body.confidence === "number" ? body.confidence : 0;

    return {
      response: {
        detected,
        action,
        duration_ms,
        whisper_loaded,
        confidence,
      },
      backendOnline: true,
      fromFallback: false,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected analyze-audio error";
    console.error("[SafeView] analyzeAudio failed:", message);
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
  return checkBackendHealthAt(resolveBackendUrl(), true);
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
