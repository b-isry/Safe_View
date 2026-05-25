// SafeView — apiTypes.ts
// Purpose: Shared TypeScript types matching backend /analyze-image JSON contract.

export type BlurAction = "BLUR" | "ALLOW";

export interface DetectionBox {
  class: string;
  confidence: number;
  box?: [number, number, number, number];
}

export interface ContentTypeGate {
  is_real_human?: boolean;
  is_animation?: boolean;
  gate_reason?: string | null;
}

export interface AnalyzeImageResponse {
  category: string;
  detected: boolean;
  confidence: number;
  action: BlurAction;
  label?: string;
  model_loaded: boolean;
  detections: DetectionBox[];
  content_type?: ContentTypeGate | null;
  gate_reason?: string | null;
  supports_boxes?: boolean;
  categories?: Record<string, AnalyzeImageResponse>;
}

export interface HealthModelsEntry {
  loaded: boolean;
  path: string;
  type: string;
  supports_boxes: boolean;
  error?: string;
}

export interface HealthResponse {
  status: string;
  backend?: string;
  models?: {
    nudity: HealthModelsEntry;
    violence: HealthModelsEntry;
  };
  model_loaded?: boolean;
  model?: string;
  whisper_loaded?: boolean;
}

/** Normalize backend JSON so detections is always an array. */
export function normalizeAnalyzeImageResponse(
  raw: Record<string, unknown>,
  fallbackCategory: string
): AnalyzeImageResponse {
  const detectionsRaw = raw.detections;
  const detections: DetectionBox[] = Array.isArray(detectionsRaw)
    ? detectionsRaw
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
        .map((entry) => ({
          class: String(entry.class ?? "unknown"),
          confidence: typeof entry.confidence === "number" ? entry.confidence : 0,
          box: Array.isArray(entry.box) && entry.box.length === 4
            ? (entry.box as [number, number, number, number])
            : undefined,
        }))
    : [];

  const categoriesRaw = raw.categories;
  let categories: Record<string, AnalyzeImageResponse> | undefined;
  if (categoriesRaw && typeof categoriesRaw === "object") {
    categories = {};
    for (const [key, value] of Object.entries(categoriesRaw)) {
      if (value && typeof value === "object") {
        categories[key] = normalizeAnalyzeImageResponse(
          value as Record<string, unknown>,
          key
        );
      }
    }
  }

  const actionRaw = raw.action;
  const action: BlurAction = actionRaw === "BLUR" ? "BLUR" : "ALLOW";

  const labelRaw = raw.label;
  const label =
    labelRaw === "NSFW" || labelRaw === "SFW" || typeof labelRaw === "string"
      ? (labelRaw as string)
      : undefined;

  return {
    category: typeof raw.category === "string" ? raw.category : fallbackCategory,
    detected: Boolean(raw.detected),
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    action,
    label,
    model_loaded: Boolean(raw.model_loaded),
    detections,
    content_type:
      raw.content_type && typeof raw.content_type === "object"
        ? (raw.content_type as ContentTypeGate)
        : null,
    gate_reason:
      typeof raw.gate_reason === "string" ? raw.gate_reason : null,
    supports_boxes:
      typeof raw.supports_boxes === "boolean" ? raw.supports_boxes : undefined,
    categories,
  };
}
