// SafeView — imageBlurDecision.ts
// Purpose: Nudity blur decision for static website images (not video frames).

import type { AnalyzeImageResponse } from "./apiTypes";

/**
 * Whether a website image should be fully blurred from classifier output.
 * Blur when the backend marks detection, requests BLUR, or score ≥ threshold.
 */
export function shouldBlurWebsiteImage(
  response: Pick<
    AnalyzeImageResponse,
    "model_loaded" | "action" | "detected" | "confidence"
  >,
  sensitivity: number
): boolean {
  if (response.model_loaded === false) {
    return false;
  }

  const threshold = Math.max(0, Math.min(1, sensitivity));
  return (
    response.confidence >= threshold ||
    response.action === "BLUR" ||
    response.detected === true
  );
}
