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

jest.mock("../src/background/businessRules", () => {
  const actual = jest.requireActual("../src/background/businessRules") as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    loadSettings: (...args: unknown[]) => mockLoadSettings(...args),
    getCachedSettings: () => mockGetCachedSettings(),
    initSettingsCache: jest.fn().mockResolvedValue(undefined),
    ensureVisionProtectionDefaults: jest.fn().mockResolvedValue(undefined),
    getEnabledCategories: (...args: unknown[]) => mockGetEnabledCategories(...args),
  };
});

Object.defineProperty(globalThis, "chrome", {
  value: {
    runtime: {
      onMessage: { addListener: jest.fn() },
      onInstalled: { addListener: jest.fn() },
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

const realHumanBlur = {
  content_type: {
    is_animation: false,
    is_real_human: true,
    gate_reason: "real_human_nudity",
  },
  gate_reason: "real_human_nudity",
};

describe("serviceWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAnalyzeImage.mockReset();
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
        ...realHumanBlur,
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

  it("sends BLUR on high score even when backend gate says ALLOW (score-primary demo)", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.95,
        action: "ALLOW",
        label: "SFW",
        model_loaded: true,
        gate_reason: "real_human_safe",
        content_type: {
          is_animation: false,
          is_real_human: true,
          gate_reason: "real_human_safe",
        },
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

  it("does not blur when score is below 50% threshold", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.49,
        action: "ALLOW",
        label: "NSFW",
        model_loaded: true,
        gate_reason: "real_human_safe",
        content_type: {
          is_animation: false,
          is_real_human: true,
          gate_reason: "real_human_safe",
        },
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

  it("blurs when score is at or above 50% threshold", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: true,
        confidence: 0.68,
        action: "BLUR",
        label: "NSFW",
        model_loaded: true,
        ...realHumanBlur,
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

  it("re-blurs when unsafe appears after a prior safe result", async () => {
    mockAnalyzeImage
      .mockResolvedValueOnce({
        response: {
          category: "nudity",
          detected: false,
          confidence: 0.2,
          action: "ALLOW",
          label: "SFW",
          model_loaded: true,
        },
        backendOnline: true,
        fromFallback: false,
      })
      .mockResolvedValueOnce({
        response: {
          category: "nudity",
          detected: true,
          confidence: 0.8,
          action: "BLUR",
          label: "NSFW",
          model_loaded: true,
          ...realHumanBlur,
        },
        backendOnline: true,
        fromFallback: false,
      });

    const { handleFrameSample, MESSAGE_ACTION_BLUR, MESSAGE_ACTION_CLEAR } =
      await import("../src/background/serviceWorker");

    await handleFrameSample({ ...framePayload, videoId: 50, requestId: 1 }, 7);
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_CLEAR,
        videoId: 50,
      })
    );

    tabsSendMessage.mockClear();
    await handleFrameSample(
      { ...framePayload, videoId: 50, requestId: 2, frameSeq: 2 },
      7
    );
    expect(tabsSendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action: MESSAGE_ACTION_BLUR,
        videoId: 50,
      })
    );
  });

  it("sends CLEAR on animation_skip gate", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0,
        action: "ALLOW",
        label: "SFW",
        model_loaded: true,
        gate_reason: "animation_skip",
        content_type: {
          is_animation: true,
          is_real_human: false,
          gate_reason: "animation_skip",
        },
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

  it("sends CLEAR on first clearly safe frame (confidence < 0.50)", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0.4,
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

  it("does not immediately clear blur when backend is offline in demo mode", async () => {
    mockAnalyzeImage.mockResolvedValue({
      response: {
        category: "nudity",
        detected: false,
        confidence: 0,
        action: "ALLOW",
        model_loaded: false,
        detections: [],
      },
      backendOnline: false,
      fromFallback: true,
    });

    const { handleFrameSample, MESSAGE_ACTION_CLEAR } = await import(
      "../src/background/serviceWorker"
    );
    await handleFrameSample({ ...framePayload, videoId: 2 }, 5);

    const clearCalls = tabsSendMessage.mock.calls.filter(
      (call) =>
        call[1] &&
        typeof call[1] === "object" &&
        (call[1] as { action?: string }).action === MESSAGE_ACTION_CLEAR
    );
    expect(clearCalls).toHaveLength(0);
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
