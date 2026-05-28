import { shouldBlurWebsiteImage } from "../src/shared/imageBlurDecision";

describe("imageBlurDecision", () => {
  it("blurs when confidence >= UI sensitivity", () => {
    expect(
      shouldBlurWebsiteImage(
        {
          model_loaded: true,
          confidence: 0.75,
          action: "ALLOW",
          detected: false,
        },
        0.75
      )
    ).toBe(true);

    expect(
      shouldBlurWebsiteImage(
        {
          model_loaded: true,
          confidence: 0.74,
          action: "ALLOW",
          detected: false,
        },
        0.75
      )
    ).toBe(false);
  });

  it("blurs on backend BLUR or detected even when score is below threshold", () => {
    expect(
      shouldBlurWebsiteImage(
        {
          model_loaded: true,
          confidence: 0.1,
          action: "BLUR",
          detected: false,
        },
        0.75
      )
    ).toBe(true);

    expect(
      shouldBlurWebsiteImage(
        {
          model_loaded: true,
          confidence: 0.1,
          action: "ALLOW",
          detected: true,
        },
        0.75
      )
    ).toBe(true);
  });

  it("does not blur when model is not loaded", () => {
    expect(
      shouldBlurWebsiteImage(
        {
          model_loaded: false,
          confidence: 0.99,
          action: "BLUR",
          detected: true,
        },
        0.75
      )
    ).toBe(false);
  });
});
