import { shouldBlurWebsiteImage } from "../src/shared/imageBlurDecision";
import { IMAGE_NUDITY_BLUR_THRESHOLD } from "../src/shared/imageNudityPolicy";

describe("imageBlurDecision", () => {
  it("blurs when confidence >= IMAGE_NUDITY_BLUR_THRESHOLD", () => {
    expect(
      shouldBlurWebsiteImage({
        model_loaded: true,
        confidence: IMAGE_NUDITY_BLUR_THRESHOLD,
        action: "ALLOW",
        detected: false,
      })
    ).toBe(true);

    expect(
      shouldBlurWebsiteImage({
        model_loaded: true,
        confidence: 0.49,
        action: "ALLOW",
        detected: false,
      })
    ).toBe(false);
  });

  it("blurs on backend BLUR or detected even when score is below threshold", () => {
    expect(
      shouldBlurWebsiteImage({
        model_loaded: true,
        confidence: 0.1,
        action: "BLUR",
        detected: false,
      })
    ).toBe(true);

    expect(
      shouldBlurWebsiteImage({
        model_loaded: true,
        confidence: 0.1,
        action: "ALLOW",
        detected: true,
      })
    ).toBe(true);
  });

  it("does not blur when model is not loaded", () => {
    expect(
      shouldBlurWebsiteImage({
        model_loaded: false,
        confidence: 0.99,
        action: "BLUR",
        detected: true,
      })
    ).toBe(false);
  });
});
