// SafeView — videoMonitor.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for video discovery via MutationObserver.

/**
 * @jest-environment jsdom
 */

jest.mock("../src/content/audioMonitor", () => ({
  prepareVideoCrossOrigin: jest.fn(),
  startSubtitleMonitor: jest.fn(),
  stopSubtitleMonitor: jest.fn(),
  onVideoTrackedForSpeakerSuppression: jest.fn(),
}));

jest.mock("../src/content/pipelineNavigation", () => ({
  onYouTubeWatchIdBoundary: jest.fn(),
  seedYouTubeWatchVideoId: jest.fn(),
}));

const rvfcCallbacks = new Map<number, VideoFrameRequestCallback>();
let nextRvfcHandle = 1;

function installVideoFrameCallbackMocks(): void {
  HTMLVideoElement.prototype.requestVideoFrameCallback = jest.fn(
    function (this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
      const handle = nextRvfcHandle++;
      rvfcCallbacks.set(handle, callback);
      return handle;
    }
  );
  HTMLVideoElement.prototype.cancelVideoFrameCallback = jest.fn((handle: number) => {
    rvfcCallbacks.delete(handle);
  });
}

function fireRvfcForVideo(video: HTMLVideoElement): void {
  for (const [handle, callback] of [...rvfcCallbacks.entries()]) {
    void callback(0, {} as VideoFrameCallbackMetadata);
    rvfcCallbacks.delete(handle);
  }
}

import {
  getVideoById,
  getVideoTrackState,
  isPrimaryCaptureTarget,
  JPEG_QUALITY,
  SAMPLE_INTERVAL_MS,
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

describe("videoMonitor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    chromeMock.runtime.sendMessage.mockClear();
    rvfcCallbacks.clear();
    nextRvfcHandle = 1;
    installVideoFrameCallbackMocks();
  });

  afterEach(async () => {
    const { stopVideoMonitor } = await import("../src/content/videoMonitor");
    stopVideoMonitor();
  });

  it("exposes 700 ms active sample interval constant", () => {
    expect(SAMPLE_INTERVAL_MS).toBe(700);
  });

  it("finds a <video> element after DOM insertion", async () => {
    const { startVideoMonitor, getVideoTrackState, stopVideoMonitor } =
      await import("../src/content/videoMonitor");

    startVideoMonitor();

    const video = document.createElement("video");
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 360, configurable: true });
    video.getBoundingClientRect = () =>
      ({
        width: 640,
        height: 360,
        top: 0,
        left: 0,
        right: 640,
        bottom: 360,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(video);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getVideoTrackState(video)).toBeDefined();
    expect(isPrimaryCaptureTarget(video)).toBe(true);
    expect(
      getVideoTrackState(video)?.usesVideoFrameCallback ||
        getVideoTrackState(video)?.intervalId !== null
    ).toBe(true);

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

  it("runs capture loop only on the primary visible video", async () => {
    const { startVideoMonitor, getVideoTrackState, stopVideoMonitor } =
      await import("../src/content/videoMonitor");

    startVideoMonitor();

    const videoA = document.createElement("video");
    const videoB = document.createElement("video");
    Object.defineProperty(videoA, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(videoA, "videoHeight", { value: 360, configurable: true });
    Object.defineProperty(videoB, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(videoB, "videoHeight", { value: 360, configurable: true });
    videoA.getBoundingClientRect = () =>
      ({
        width: 200,
        height: 120,
        top: 0,
        left: 0,
        right: 200,
        bottom: 120,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    videoB.getBoundingClientRect = () =>
      ({
        width: 1280,
        height: 720,
        top: 0,
        left: 0,
        right: 1280,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    document.body.appendChild(videoA);
    document.body.appendChild(videoB);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(isPrimaryCaptureTarget(videoB)).toBe(true);
    expect(isPrimaryCaptureTarget(videoA)).toBe(false);
    expect(getVideoTrackState(videoB)?.usesVideoFrameCallback).toBe(true);
    expect(getVideoTrackState(videoA)?.usesVideoFrameCallback).toBe(false);
    expect(getVideoTrackState(videoA)?.intervalId).toBeNull();

    stopVideoMonitor();
  });

  it("purges canvas dimensions after toBlob (BR-02)", async () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "videoWidth", { value: 64, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 48, configurable: true });
    Object.defineProperty(video, "readyState", {
      value: HTMLMediaElement.HAVE_CURRENT_DATA,
      configurable: true,
    });
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 1, configurable: true });
    video.getBoundingClientRect = () =>
      ({
        width: 640,
        height: 360,
        top: 0,
        left: 0,
        right: 640,
        bottom: 360,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const drawImage = jest.fn();
    const imageData = new Uint8ClampedArray(32 * 32 * 4);
    imageData.fill(200);
    const toBlob = jest.fn((callback: BlobCallback) => {
      const blob = new Blob(["jpeg-bytes"], { type: "image/jpeg" });
      blob.arrayBuffer = () => Promise.resolve(new ArrayBuffer(10));
      callback(blob);
    });

    const originalCreateElement = document.createElement.bind(document);
    jest.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      if (tagName === "canvas") {
        const canvas = originalCreateElement("canvas") as HTMLCanvasElement;
        canvas.width = 64;
        canvas.height = 48;
        canvas.getContext = jest.fn(
          () =>
            ({
              drawImage,
              getImageData: () => ({ data: imageData }),
            }) as unknown as CanvasRenderingContext2D
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

    fireRvfcForVideo(video);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const createdCanvas = (document.createElement as jest.Mock).mock.results.find(
      (result) => result.value instanceof HTMLCanvasElement
    )?.value as HTMLCanvasElement | undefined;

    expect(drawImage).toHaveBeenCalledWith(
      video,
      0,
      0,
      64,
      48
    );
    expect(toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/jpeg",
      JPEG_QUALITY
    );
    expect(createdCanvas?.width).toBe(64);
    expect(createdCanvas?.height).toBe(48);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FRAME_SAMPLE",
        framePayload: expect.any(Array),
        frameBuffer: expect.any(Uint8Array),
        frameMimeType: "image/jpeg",
        frameSeq: expect.any(Number),
      })
    );

    stopVideoMonitor();
    jest.restoreAllMocks();
  });
});
