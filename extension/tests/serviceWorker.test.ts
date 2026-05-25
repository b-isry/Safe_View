// SafeView — serviceWorker.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Service worker sends BLUR/CLEAR based on mocked backend responses.

const mockAnalyzeImage = jest.fn();
const mockAnalyzeAudio = jest.fn();
const mockLoadSettings = jest.fn();
const mockGetEnabledCategories = jest.fn();
const tabsSendMessage = jest.fn().mockResolvedValue(undefined);

jest.mock("../src/background/aiClient", () => ({
  analyzeImage: (...args: unknown[]) => mockAnalyzeImage(...args),
  analyzeAudio: (...args: unknown[]) => mockAnalyzeAudio(...args),
  loadBackendStatusFromStorage: jest.fn().mockResolvedValue({
    online: true,
    lastCheckedAt: 0,
  }),
}));

const mockGetCachedSettings = jest.fn();

jest.mock("../src/background/businessRules", () => ({
  loadSettings: (...args: unknown[]) => mockLoadSettings(...args),
  getCachedSettings: () => mockGetCachedSettings(),
  initSettingsCache: jest.fn().mockResolvedValue(undefined),
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
  language: "en" as const,
};

const jpegBytes = Array.from(new TextEncoder().encode("jpeg"));
const framePayload = {
  action: "FRAME_SAMPLE" as const,
  videoId: 1,
  framePayload: jpegBytes,
  frameMimeType: "image/jpeg",
  frameSeq: 1,
};

describe("serviceWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSettings.mockResolvedValue(defaultSettings);
    mockGetCachedSettings.mockReturnValue(defaultSettings);
    mockGetEnabledCategories.mockReturnValue(["nudity"]);
  });

  it("sends BLUR to the tab when label is NSFW and score exceeds threshold", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: true,
        confidence: 0.87,
        action: "BLUR",
        label: "NSFW",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_BLUR } = await import(
      "../src/background/serviceWorker"
    );

    await handleFrameSample(framePayload, 99);

    expect(mockAnalyzeImage).toHaveBeenCalled();
    expect(tabsSendMessage).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        action: MESSAGE_ACTION_BLUR,
        videoId: 1,
      })
    );
  });

  it("does not blur high score when label is SFW", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.95,
        action: "ALLOW",
        label: "SFW",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_BLUR, MESSAGE_ACTION_CLEAR } =
      await import("../src/background/serviceWorker");

    await handleFrameSample(framePayload, 7);

    expect(tabsSendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_BLUR,
        videoId: 1,
      })
    );
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_CLEAR,
        videoId: 1,
      })
    );
  });

  it("does not blur when score is below suspicious floor (0.50)", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.45,
        action: "ALLOW",
        label: "SFW",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_BLUR } = await import(
      "../src/background/serviceWorker"
    );

    await handleFrameSample(framePayload, 7);

    expect(tabsSendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_BLUR,
        videoId: 1,
      })
    );
  });

  it("CLEARs when backend returns detected false with ALLOW", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.55,
        action: "ALLOW",
        label: "NSFW",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_BLUR, MESSAGE_ACTION_CLEAR } =
      await import("../src/background/serviceWorker");

    await handleFrameSample(framePayload, 7);

    expect(tabsSendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_BLUR,
        videoId: 1,
      })
    );
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_CLEAR,
        videoId: 1,
      })
    );
  });

  it("blurs when nudity detected at or above blur threshold (0.82)", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: true,
        confidence: 0.88,
        action: "BLUR",
        label: "NSFW",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_BLUR } = await import(
      "../src/background/serviceWorker"
    );

    await handleFrameSample(framePayload, 7);

    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_BLUR,
        videoId: 1,
      })
    );
  });

  it("sends CLEAR on first SFW frame", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.5,
        action: "ALLOW",
        label: "SFW",
        model_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleFrameSample, MESSAGE_ACTION_CLEAR } = await import(
      "../src/background/serviceWorker"
    );
    await handleFrameSample(framePayload, 12);
    expect(tabsSendMessage).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        action: MESSAGE_ACTION_CLEAR,
        videoId: 1,
      })
    );
  });

  it("does not clear blur when backend is offline (HOLD, no CLEAR)", async () => {
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
    await handleFrameSample({ ...framePayload, videoId: 2 }, 5);

    expect(tabsSendMessage).not.toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        action: MESSAGE_ACTION_CLEAR,
        videoId: 2,
      })
    );
  });

  it("sends MUTE when analyze-audio reports profanity", async () => {
    mockLoadSettings.mockResolvedValue({
      ...defaultSettings,
      categories: { ...defaultSettings.categories, profanity: true },
    });
    mockAnalyzeAudio.mockResolvedValue({
      response: {
        detected: true,
        action: "MUTE",
        duration_ms: 1500,
        whisper_loaded: true,
      },
      backendOnline: true,
      fromFallback: false,
    });

    const { handleAudioChunk, MESSAGE_ACTION_MUTE } = await import(
      "../src/background/serviceWorker"
    );

    await handleAudioChunk(
      {
        action: "AUDIO_CHUNK",
        videoId: 3,
        audioBase64: btoa("webm"),
        language: "en",
      },
      12
    );

    expect(mockAnalyzeAudio).toHaveBeenCalled();
    expect(tabsSendMessage).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        action: MESSAGE_ACTION_MUTE,
        videoId: 3,
        duration_ms: 1500,
      })
    );
  });

  it("skips analyze-audio when profanity filter is disabled", async () => {
    mockLoadSettings.mockResolvedValue({
      ...defaultSettings,
      categories: { ...defaultSettings.categories, profanity: false },
    });

    const { handleAudioChunk } = await import("../src/background/serviceWorker");

    await handleAudioChunk(
      {
        action: "AUDIO_CHUNK",
        videoId: 4,
        audioBase64: btoa("webm"),
        language: "en",
      },
      7
    );

    expect(mockAnalyzeAudio).not.toHaveBeenCalled();
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });
});
