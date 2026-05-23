// SafeView — audioMonitor.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for BR-05 mute handling from service worker MUTE commands.

/**
 * @jest-environment jsdom
 */


const chromeMock = {
  runtime: {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    onMessage: {
      addListener: jest.fn(),
    },
  },
};

Object.defineProperty(globalThis, "chrome", {
  value: chromeMock,
  configurable: true,
});

describe("audioMonitor MUTE listener", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    const { stopVideoMonitor } = await import("../src/content/videoMonitor");
    stopVideoMonitor();
  });

  it("applies BR-05 mute for exactly 1500 ms on MUTE command", async () => {
    const { initAudioMuteListener, MESSAGE_ACTION_MUTE } = await import(
      "../src/content/audioMonitor"
    );
    const { startVideoMonitor, getVideoById, getVideoTrackState, stopVideoMonitor } =
      await import("../src/content/videoMonitor");

    let messageListener: (message: unknown) => void = () => {};
    chromeMock.runtime.onMessage.addListener.mockImplementation((listener) => {
      messageListener = listener;
    });

    initAudioMuteListener();
    startVideoMonitor();

    const video = document.createElement("video");
    document.body.appendChild(video);

    await Promise.resolve();

    const videoId = getVideoTrackState(video)?.videoId;
    expect(videoId).toBeGreaterThan(0);
    expect(getVideoById(videoId!)).toBe(video);

    messageListener({
      action: MESSAGE_ACTION_MUTE,
      videoId,
      duration_ms: 1500,
    });

    expect(video.muted).toBe(true);

    jest.advanceTimersByTime(1499);
    expect(video.muted).toBe(true);

    jest.advanceTimersByTime(1);
    expect(video.muted).toBe(false);

    stopVideoMonitor();
  });
});
