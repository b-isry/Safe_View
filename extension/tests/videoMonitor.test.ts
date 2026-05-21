// SafeView — videoMonitor.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for video discovery via MutationObserver.

/**
 * @jest-environment jsdom
 */

import {
  getVideoById,
  getVideoTrackState,
  SAMPLE_INTERVAL_MS,
} from "../src/content/videoMonitor";

const chromeMock = {
  runtime: {
    sendMessage: jest.fn().mockResolvedValue(undefined),
  },
};

Object.defineProperty(globalThis, "chrome", {
  value: chromeMock,
  configurable: true,
});

describe("videoMonitor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    chromeMock.runtime.sendMessage.mockClear();
  });

  afterEach(async () => {
    const { stopVideoMonitor } = await import("../src/content/videoMonitor");
    stopVideoMonitor();
  });

  it("exposes 500 ms sample interval constant", () => {
    expect(SAMPLE_INTERVAL_MS).toBe(500);
  });

  it("finds a <video> element after DOM insertion", async () => {
    const { startVideoMonitor, getVideoTrackState, stopVideoMonitor } =
      await import("../src/content/videoMonitor");

    startVideoMonitor();

    const video = document.createElement("video");
    document.body.appendChild(video);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getVideoTrackState(video)).toBeDefined();
    expect(getVideoTrackState(video)?.intervalId).not.toBeNull();

    stopVideoMonitor();
  });

  it("finds <video> inside a dynamically added container", async () => {
    const { startVideoMonitor, getVideoTrackState, stopVideoMonitor } =
      await import("../src/content/videoMonitor");

    startVideoMonitor();

    const wrapper = document.createElement("div");
    const video = document.createElement("video");
    wrapper.appendChild(video);
    document.body.appendChild(wrapper);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getVideoTrackState(video)).toBeDefined();
    expect(getVideoTrackState(video)?.videoId).toBeGreaterThan(0);

    stopVideoMonitor();
  });

  it("tracks multiple videos with unique ids", async () => {
    const { startVideoMonitor, getVideoTrackState, getVideoById, stopVideoMonitor } =
      await import("../src/content/videoMonitor");

    startVideoMonitor();

    const videoA = document.createElement("video");
    const videoB = document.createElement("video");
    document.body.appendChild(videoA);
    document.body.appendChild(videoB);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const stateA = getVideoTrackState(videoA);
    const stateB = getVideoTrackState(videoB);

    expect(stateA).toBeDefined();
    expect(stateB).toBeDefined();
    expect(stateA?.videoId).not.toBe(stateB?.videoId);
    expect(getVideoById(stateA!.videoId)).toBe(videoA);
    expect(getVideoById(stateB!.videoId)).toBe(videoB);

    stopVideoMonitor();
  });

  it("purges canvas dimensions after toBlob (BR-02)", async () => {
    jest.useFakeTimers();

    const video = document.createElement("video");
    Object.defineProperty(video, "videoWidth", { value: 64, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 48, configurable: true });
    Object.defineProperty(video, "readyState", {
      value: HTMLMediaElement.HAVE_CURRENT_DATA,
      configurable: true,
    });

    const drawImage = jest.fn();
    const toBlob = jest.fn((callback: BlobCallback) => {
      callback(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
    });

    const originalCreateElement = document.createElement.bind(document);
    jest.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      if (tagName === "canvas") {
        const canvas = originalCreateElement("canvas") as HTMLCanvasElement;
        canvas.width = 64;
        canvas.height = 48;
        canvas.getContext = jest.fn(
          () => ({ drawImage }) as unknown as CanvasRenderingContext2D
        );
        canvas.toBlob = toBlob;
        return canvas;
      }
      return originalCreateElement(tagName);
    });

    const { startVideoMonitor, stopVideoMonitor } = await import(
      "../src/content/videoMonitor"
    );
    document.body.appendChild(video);
    startVideoMonitor();

    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    const createdCanvas = (document.createElement as jest.Mock).mock.results.find(
      (result) => result.value instanceof HTMLCanvasElement
    )?.value as HTMLCanvasElement | undefined;

    expect(drawImage).toHaveBeenCalled();
    expect(toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/jpeg",
      0.7
    );
    expect(createdCanvas?.width).toBe(0);
    expect(createdCanvas?.height).toBe(0);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FRAME_SAMPLE",
        frameBase64: expect.any(String),
        frameMimeType: "image/jpeg",
      })
    );

    stopVideoMonitor();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
});
