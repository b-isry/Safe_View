// SafeView — serviceWorker.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Service worker sends BLUR/CLEAR based on mocked backend responses.

const mockAnalyzeImage = jest.fn();
const mockLoadSettings = jest.fn();
const mockGetEnabledCategories = jest.fn();
const tabsSendMessage = jest.fn().mockResolvedValue(undefined);

jest.mock("../src/background/aiClient", () => ({
  analyzeImage: (...args: unknown[]) => mockAnalyzeImage(...args),
  loadBackendStatusFromStorage: jest.fn().mockResolvedValue({
    online: true,
    lastCheckedAt: 0,
  }),
}));

jest.mock("../src/background/businessRules", () => ({
  loadSettings: (...args: unknown[]) => mockLoadSettings(...args),
  getEnabledCategories: (...args: unknown[]) => mockGetEnabledCategories(...args),
  shouldBlur: jest.requireActual("../src/background/businessRules").shouldBlur,
  effectiveThreshold: jest.requireActual("../src/background/businessRules")
    .effectiveThreshold,
  CONFIDENCE_FLOOR: jest.requireActual("../src/background/businessRules")
    .CONFIDENCE_FLOOR,
}));

Object.defineProperty(globalThis, "chrome", {
  value: {
    runtime: {
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn(),
      getManifest: jest.fn().mockReturnValue({ version: "0.1.3" }),
    },
    tabs: { sendMessage: tabsSendMessage },
    storage: {
      local: {
        get: jest.fn().mockResolvedValue({}),
        set: jest.fn().mockResolvedValue(undefined),
      },
    },
  },
  configurable: true,
});

const defaultSettings = {
  protectionEnabled: true,
  backendUrl: "http://localhost:8000",
  sensitivity: 0.75,
  categories: {
    nudity: true,
    violence: false,
    kissing: false,
    profanity: false,
    lgbtq: false,
  },
  profanityWords: [] as string[],
};

const framePayload = {
  action: "FRAME_SAMPLE" as const,
  videoId: 1,
  frameBase64: btoa("jpeg"),
  frameMimeType: "image/jpeg",
};

describe("serviceWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSettings.mockResolvedValue(defaultSettings);
    mockGetEnabledCategories.mockReturnValue(["nudity"]);
  });

  it("sends BLUR to the tab when backend confidence exceeds BR-01 threshold", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: true,
        confidence: 0.87,
        action: "BLUR",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_BLUR } = await import(
      "../src/background/serviceWorker"
    );

    await handleFrameSample(framePayload, { tab: { id: 99 } } as chrome.runtime.MessageSender);

    expect(mockAnalyzeImage).toHaveBeenCalled();
    expect(tabsSendMessage).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        action: MESSAGE_ACTION_BLUR,
        videoId: 1,
      })
    );
  });

  it("sends optimistic BLUR when score is ≥0.65 but below BR-01", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.68,
        action: "ALLOW",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_BLUR } = await import(
      "../src/background/serviceWorker"
    );

    await handleFrameSample(framePayload, { tab: { id: 7 } } as chrome.runtime.MessageSender);

    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_BLUR,
        videoId: 1,
      })
    );
  });

  it("sends CLEAR only after two consecutive scores below 0.65", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.5,
        action: "ALLOW",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_CLEAR } = await import(
      "../src/background/serviceWorker"
    );
    const sender = { tab: { id: 12 } } as chrome.runtime.MessageSender;

    await handleFrameSample(framePayload, sender);
    expect(tabsSendMessage).not.toHaveBeenCalled();

    await handleFrameSample({ ...framePayload, videoId: 1 }, sender);
    expect(tabsSendMessage).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        action: MESSAGE_ACTION_CLEAR,
        videoId: 1,
      })
    );
  });

  it("sends CLEAR when backend is offline (fail open)", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0,
        action: "ALLOW",
        model_loaded: false,
      },
      backendOnline: false,
      fromFallback: true,
    });

    const { handleFrameSample, MESSAGE_ACTION_CLEAR } = await import(
      "../src/background/serviceWorker"
    );
    const sender = { tab: { id: 5 } } as chrome.runtime.MessageSender;

    await handleFrameSample({ ...framePayload, videoId: 2 }, sender);
    await handleFrameSample({ ...framePayload, videoId: 2 }, sender);

    expect(tabsSendMessage).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        action: MESSAGE_ACTION_CLEAR,
        videoId: 2,
      })
    );
  });
});
