// SafeView — blurManager.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for full-video blur apply/remove and multi-video handling.

/**
 * @jest-environment jsdom
 */

jest.mock("../src/content/audioMonitor", () => ({
  prepareVideoCrossOrigin: jest.fn(),
  startSubtitleMonitor: jest.fn(),
  stopSubtitleMonitor: jest.fn(),
  onVideoTrackedForSpeakerSuppression: jest.fn(),
}));

import {
  BLUR_FILTER,
  BLUR_RADIUS_PX,
  BLUR_TRANSITION,
  MESSAGE_ACTION_BLUR,
  MESSAGE_ACTION_CLEAR,
  MIN_BLUR_HOLD_MS,
  CLEAR_STREAK_REQUIRED,
  applyBlur,
  applyImmediateLocalBlur,
  clearBlur,
  clearImmediateLocalBlur,
  initBlurManager,
  isVideoBlurred,
  teardownBlurManager,
} from "../src/content/blurManager";
import {
  getVideoTrackState,
  startVideoMonitor,
  stopVideoMonitor,
} from "../src/content/videoMonitor";

const chromeMock = {
  runtime: {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    getManifest: jest.fn().mockReturnValue({ version: "0.1.3" }),
    onMessage: {
      addListener: jest.fn(),
    },
  },
  storage: {
    local: {
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
    },
    onChanged: {
      addListener: jest.fn(),
    },
  },
};

Object.defineProperty(globalThis, "chrome", {
  value: chromeMock,
  configurable: true,
});

function readVideoFilter(video: HTMLVideoElement): string {
  return video.style.getPropertyValue("filter") || video.style.filter;
}

function mockVideoLayout(
  video: HTMLVideoElement,
  width: number,
  height: number
): void {
  video.getBoundingClientRect = () =>
    ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
}

describe("blurManager", () => {
  let messageListener: (message: unknown) => void;

  beforeEach(() => {
    document.body.innerHTML = "";
    chromeMock.runtime.onMessage.addListener.mockClear();
    chromeMock.runtime.onMessage.addListener.mockImplementation((listener) => {
      messageListener = listener as (message: unknown) => void;
    });
    teardownBlurManager();
    stopVideoMonitor();
  });

  afterEach(() => {
    teardownBlurManager();
    stopVideoMonitor();
  });

  it("uses blur(24px) filter constant", () => {
    expect(BLUR_RADIUS_PX).toBe(24);
    expect(BLUR_FILTER).toBe("blur(24px)");
  });

  it("applies blur(24px) instantly on BLUR (no transition)", () => {
    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);
    document.body.appendChild(video);
    startVideoMonitor();

    const videoId = getVideoTrackState(video)?.videoId;
    applyBlur(videoId!);

    expect(readVideoFilter(video)).toBe(BLUR_FILTER);
    expect(video.style.transition).toBe("none");
    expect(isVideoBlurred(video)).toBe(true);

    stopVideoMonitor();
  });

  it("removes blur and restores original styles on CLEAR", () => {
    jest.useFakeTimers();
    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);
    video.style.filter = "brightness(1.1)";
    video.style.transition = "opacity 0.2s";
    document.body.appendChild(video);
    startVideoMonitor();

    const videoId = getVideoTrackState(video)?.videoId;
    applyImmediateLocalBlur(video);
    clearBlur(videoId!);
    jest.advanceTimersByTime(0);
    jest.useRealTimers();

    expect(video.style.filter).toBe("brightness(1.1)");
    expect(video.style.transition).toBe("opacity 0.2s");
    expect(isVideoBlurred(video)).toBe(false);

    stopVideoMonitor();
  });

  it("applies blur when service worker sends BLUR message", () => {
    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);
    document.body.appendChild(video);
    startVideoMonitor();
    initBlurManager();

    const videoId = getVideoTrackState(video)?.videoId;

    messageListener({
      action: MESSAGE_ACTION_BLUR,
      videoId,
    });

    expect(readVideoFilter(video)).toBe(BLUR_FILTER);
    expect(isVideoBlurred(video)).toBe(true);

    stopVideoMonitor();
  });

  it("removes blur when service worker sends CLEAR message", () => {
    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);
    document.body.appendChild(video);
    startVideoMonitor();
    initBlurManager();

    const videoId = getVideoTrackState(video)?.videoId;

    messageListener({ action: MESSAGE_ACTION_CLEAR, videoId });

    expect(readVideoFilter(video)).toBe("");
    expect(isVideoBlurred(video)).toBe(false);

    stopVideoMonitor();
  });

  it("blurs the largest visible video when multiple players exist", () => {
    jest.useFakeTimers();
    const videoA = document.createElement("video");
    const videoB = document.createElement("video");
    mockVideoLayout(videoA, 1280, 720);
    mockVideoLayout(videoB, 160, 90);
    document.body.appendChild(videoA);
    document.body.appendChild(videoB);
    startVideoMonitor();

    const idB = getVideoTrackState(videoB)?.videoId;

    applyBlur(idB!);

    expect(readVideoFilter(videoA)).toBe(BLUR_FILTER);
    expect(readVideoFilter(videoB)).toBe("");

    clearBlur(idB!);
    jest.useRealTimers();

    expect(readVideoFilter(videoA)).toBe("");

    stopVideoMonitor();
  });

  it("does not blur YouTube player chrome outside the video surface", () => {
    const locationSpy = jest
      .spyOn(window, "location", "get")
      .mockReturnValue({ hostname: "www.youtube.com" } as Location);

    const player = document.createElement("div");
    player.id = "movie_player";

    const surface = document.createElement("div");
    surface.className = "html5-video-container";

    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);

    const controls = document.createElement("div");
    controls.className = "ytp-chrome-bottom";

    surface.appendChild(video);
    player.appendChild(surface);
    player.appendChild(controls);
    document.body.appendChild(player);
    startVideoMonitor();

    const videoId = getVideoTrackState(video)?.videoId;
    applyBlur(videoId!);

    expect(readVideoFilter(video)).toBe(BLUR_FILTER);
    expect(player.style.filter).toBe("");
    expect(controls.style.filter).toBe("");

    const overlay = document.querySelector(".safeview-blur-overlay");
    expect(overlay?.parentElement).toBe(surface);
    expect(overlay?.parentElement).not.toBe(player);

    locationSpy.mockRestore();
    stopVideoMonitor();
  });

  it("ignores BLUR for unknown or removed video ids", async () => {
    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);
    document.body.appendChild(video);
    startVideoMonitor();
    await new Promise((resolve) => setTimeout(resolve, 0));

    applyBlur(999);
    expect(readVideoFilter(video)).toBe(BLUR_FILTER);

    const videoId = getVideoTrackState(video)?.videoId;
    applyBlur(videoId!);
    video.remove();
    applyBlur(videoId!);
    expect(isVideoBlurred(video)).toBe(false);

    stopVideoMonitor();
  });
});
