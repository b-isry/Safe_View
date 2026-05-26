// SafeView — aiClient.ts
// Purpose: fetch() wrapper for localhost FastAPI POST /analyze-image.

import {
  DEFAULT_BACKEND_URL,
  DEFAULT_SENSITIVITY,
  PROFANITY_MUTE_DURATION_MS,
  getCachedSettings,
} from "./businessRules";
import { isProfanityProtectionActive } from "../shared/settingsMessages";
import {
  ANALYZE_IMAGE_TIMEOUT_MS,
  BACKEND_OFFLINE_FAILURE_STREAK,
} from "./latencyPolicy";
import {
  normalizeAnalyzeImageResponse,
  type AnalyzeImageResponse,
  type HealthResponse,
} from "../shared/apiTypes";

/** JSON body returned by the SafeView backend POST /analyze-audio endpoint. */
export interface AnalyzeAudioResponse {
  detected: boolean;
  action: "MUTE" | "ALLOW" | "BEEP";
  audio_action?: string;
  duration_ms: number;
  whisper_loaded: boolean;
  confidence: number;
}

export interface AnalyzeAudioResult {
  response: AnalyzeAudioResponse;
  backendOnline: boolean;
  fromFallback: boolean;
}

export type { AnalyzeImageResponse, HealthResponse };

export interface AnalyzeImageResult {
  response: AnalyzeImageResponse;
  backendOnline: boolean;
  fromFallback: boolean;
}

export interface BackendStatus {
  online: boolean;
  lastCheckedAt: number;
  lastError?: string;
  modelLoaded?: boolean;
}

export const BACKEND_STATUS_STORAGE_KEY = "safeview_backend_status";

const ACTION_ALLOW = "ALLOW" as const;
const ACTION_MUTE = "MUTE" as const;

let consecutiveFailures = 0;

function buildSafeAudioDefaultResponse(): AnalyzeAudioResponse {
  return {
    detected: false,
    action: ACTION_ALLOW,
    duration_ms: 0,
    whisper_loaded: false,
    confidence: 0,
  };
}

let cachedBackendStatus: BackendStatus = {
  online: true,
  lastCheckedAt: 0,
};

export function getBackendStatus(): BackendStatus {
  return { ...cachedBackendStatus };
}

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

async function markBackendOffline(errorMessage?: string): Promise<void> {
  consecutiveFailures += 1;
  if (consecutiveFailures < BACKEND_OFFLINE_FAILURE_STREAK) {
    return;
  }

  await persistBackendStatus({
    online: false,
    lastCheckedAt: Date.now(),
    lastError: errorMessage,
  });
}

async function markBackendOnline(modelLoaded?: boolean): Promise<void> {
  consecutiveFailures = 0;
  await persistBackendStatus({
    online: true,
    lastCheckedAt: Date.now(),
    modelLoaded:
      typeof modelLoaded === "boolean" ? modelLoaded : cachedBackendStatus.modelLoaded,
  });
}

function buildSafeDefaultResponse(category: string): AnalyzeImageResponse {
  return {
    category,
    detected: false,
    confidence: 0,
    action: ACTION_ALLOW,
    model_loaded: false,
    detections: [],
    content_type: null,
    gate_reason: null,
  };
}

function resolveBackendUrl(): string {
  return getCachedSettings().backendUrl || DEFAULT_BACKEND_URL;
}

export interface ParsedAnalyzeImageBody {
  label?: string;
  score: number;
  category?: string;
  detected?: boolean;
  action?: string;
  model_loaded?: boolean;
  gate_reason?: string;
  content_type?: AnalyzeImageResponse["content_type"];
  detections?: AnalyzeImageResponse["detections"];
  supports_boxes?: boolean;
  categories?: AnalyzeImageResponse["categories"];
}

function stripMarkdownJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

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

      const normalized = normalizeAnalyzeImageResponse(
        { ...body, confidence: score },
        typeof body.category === "string" ? body.category : "nudity"
      );

      return {
        label: normalized.label,
        score: normalized.confidence,
        category: normalized.category,
        detected: normalized.detected,
        action: normalized.action,
        model_loaded: normalized.model_loaded,
        gate_reason: normalized.gate_reason ?? undefined,
        content_type: normalized.content_type,
        detections: normalized.detections,
        supports_boxes: normalized.supports_boxes,
        categories: normalized.categories,
      };
    } catch {
      // try next candidate
    }
  }

  console.error("[SafeView] Unparseable analyze-image response");
  return null;
}

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

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), ANALYZE_IMAGE_TIMEOUT_MS);

  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const backendUrl = resolveBackendUrl();
    const baseUrl = backendUrl.replace(/\/$/, "");
    const endpoint = `${baseUrl}/analyze-image`;

    const settings = getCachedSettings();
    const filterProfanity = isProfanityProtectionActive(settings);

    const formData = new FormData();
    formData.append("frame", frame, "frame.jpg");
    formData.append("sensitivity", String(sensitivity));
    formData.append("category", category);
    formData.append("filter_profanity", filterProfanity ? "true" : "false");

    let response: Response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        body: formData,
        signal: combinedSignal,
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
    } finally {
      clearTimeout(timeoutId);
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

    await markBackendOnline(parsed.model_loaded);

    const responseBody = normalizeAnalyzeImageResponse(
      {
        category: parsed.category ?? category,
        detected: parsed.detected,
        confidence: parsed.score,
        action: parsed.action,
        label: parsed.label,
        model_loaded: parsed.model_loaded,
        gate_reason: parsed.gate_reason,
        content_type: parsed.content_type,
        detections: parsed.detections,
        supports_boxes: parsed.supports_boxes,
        categories: parsed.categories,
      },
      category
    );

    return {
      response: responseBody,
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

export async function analyzeAudio(
  audio: Blob,
  language: string,
  sensitivity: number = DEFAULT_SENSITIVITY,
  profanityWords?: string[]
): Promise<AnalyzeAudioResult> {
  const safeDefault = buildSafeAudioDefaultResponse();

  try {
    const backendUrl = resolveBackendUrl();
    const baseUrl = backendUrl.replace(/\/$/, "");
    const endpoint = `${baseUrl}/analyze-audio`;

    const words =
      profanityWords ?? getCachedSettings().profanityWords ?? [];

    const formData = new FormData();
    formData.append("audio_chunk", audio, "chunk.webm");
    formData.append("language", language);
    formData.append("sensitivity", String(sensitivity));
    formData.append("profanity_words", JSON.stringify(words));

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
    const audio_action =
      typeof body.audio_action === "string" ? body.audio_action : undefined;
    const actionRaw = typeof body.action === "string" ? body.action : ACTION_ALLOW;
    const action =
      actionRaw === "BEEP" || audio_action === "BEEP"
        ? "BEEP"
        : actionRaw === ACTION_MUTE
          ? ACTION_MUTE
          : ACTION_ALLOW;
    const duration_ms =
      typeof body.duration_ms === "number" && body.duration_ms > 0
        ? body.duration_ms
        : detected
          ? PROFANITY_MUTE_DURATION_MS
          : 0;
    const whisper_loaded = Boolean(body.whisper_loaded);
    const confidence =
      typeof body.confidence === "number" ? body.confidence : 0;

    return {
      response: {
        detected,
        action,
        audio_action: audio_action ?? action,
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

    const body = (await response.json()) as HealthResponse;

    if (body.status === "ok") {
      const nudityLoaded = body.models?.nudity?.loaded ?? body.model_loaded;
      if (updateStatusFlag) {
        await markBackendOnline(nudityLoaded);
      }
      return Boolean(nudityLoaded);
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

export async function checkBackendHealth(): Promise<boolean> {
  return checkBackendHealthAt(resolveBackendUrl(), true);
}

export async function loadBackendStatusFromStorage(): Promise<BackendStatus> {
  try {
    const stored = await chrome.storage.local.get(BACKEND_STATUS_STORAGE_KEY);
    const raw = stored[BACKEND_STATUS_STORAGE_KEY] as BackendStatus | undefined;

    if (raw && typeof raw.online === "boolean") {
      cachedBackendStatus = {
        online: raw.online,
        lastCheckedAt: raw.lastCheckedAt ?? 0,
        lastError: raw.lastError,
        modelLoaded: raw.modelLoaded,
      };
    }
  } catch (error) {
    console.error("[SafeView] Failed to load backend status:", error);
  }

  return getBackendStatus();
}
