// SafeView — imageBlurDecision.ts
// Purpose: Nudity blur decision for static website images (not video frames).

import type { AnalyzeImageResponse } from "./apiTypes";
import { IMAGE_NUDITY_BLUR_THRESHOLD } from "./imageNudityPolicy";

/**
 * Whether a website image should be fully blurred from classifier output.
 * Blur when the backend marks detection, requests BLUR, or score ≥ threshold.
 */
export function shouldBlurWebsiteImage(
  response: Pick<
    AnalyzeImageResponse,
    "model_loaded" | "action" | "detected" | "confidence"
  >
): boolean {
  if (response.model_loaded === false) {
    return false;
  }

  return (
    response.confidence >= IMAGE_NUDITY_BLUR_THRESHOLD ||
    response.action === "BLUR" ||
    response.detected === true
  );
}
