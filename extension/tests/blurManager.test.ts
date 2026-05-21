// SafeView — blurManager.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for full-video blur apply/remove and multi-video handling.

/**
 * @jest-environment jsdom
 */

import {
  BLUR_FILTER,
  BLUR_RADIUS_PX,
  BLUR_TRANSITION,
  MESSAGE_ACTION_BLUR,
  MESSAGE_ACTION_CLEAR,
  MIN_BLUR_HOLD_MS,
  CLEAR_STREAK_REQUIRED,
  applyBlur,
  clearBlur,
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
    onMessage: {
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

  it("applies blur(24px) with 0.15s transition on BLUR", () => {
    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);
    document.body.appendChild(video);
    startVideoMonitor();

    const videoId = getVideoTrackState(video)?.videoId;
    applyBlur(videoId!);

    expect(readVideoFilter(video)).toBe(BLUR_FILTER);
    expect(video.style.transition).toBe(BLUR_TRANSITION);
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
    applyBlur(videoId!);
    jest.advanceTimersByTime(MIN_BLUR_HOLD_MS + 1);
    for (let i = 0; i < CLEAR_STREAK_REQUIRED; i += 1) {
      clearBlur(videoId!);
    }
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
    jest.useFakeTimers();
    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);
    document.body.appendChild(video);
    startVideoMonitor();
    initBlurManager();

    const videoId = getVideoTrackState(video)?.videoId;

    messageListener({ action: MESSAGE_ACTION_BLUR, videoId });
    jest.advanceTimersByTime(MIN_BLUR_HOLD_MS + 1);
    for (let i = 0; i < CLEAR_STREAK_REQUIRED; i += 1) {
      messageListener({ action: MESSAGE_ACTION_CLEAR, videoId });
    }
    jest.useRealTimers();

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

    jest.advanceTimersByTime(MIN_BLUR_HOLD_MS + 1);
    for (let i = 0; i < CLEAR_STREAK_REQUIRED; i += 1) {
      clearBlur(idB!);
    }
    jest.useRealTimers();

    expect(readVideoFilter(videoA)).toBe("");

    stopVideoMonitor();
  });

  it("ignores BLUR for unknown or removed video ids", () => {
    const video = document.createElement("video");
    mockVideoLayout(video, 640, 360);
    document.body.appendChild(video);
    startVideoMonitor();

    applyBlur(999);
    expect(readVideoFilter(video)).toBe("");

    const videoId = getVideoTrackState(video)?.videoId;
    applyBlur(videoId!);
    video.remove();
    applyBlur(videoId!);
    expect(isVideoBlurred(video)).toBe(false);

    stopVideoMonitor();
  });
});
