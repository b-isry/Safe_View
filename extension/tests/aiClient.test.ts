// SafeView — aiClient.test.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for aiClient fail-open behavior and backend status flag.

import {
  BACKEND_STATUS_STORAGE_KEY,
  analyzeImage,
  getBackendStatus,
  parseAnalyzeImageResponseText,
} from "../src/background/aiClient";
import { SETTINGS_STORAGE_KEY } from "../src/background/businessRules";

const storageData: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: jest.fn((keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        keyList.forEach((key) => {
          if (storageData[key] !== undefined) {
            result[key] = storageData[key];
          }
        });
        return Promise.resolve(result);
      }),
      set: jest.fn((items: Record<string, unknown>) => {
        Object.assign(storageData, items);
        return Promise.resolve();
      }),
    },
  },
};

Object.defineProperty(globalThis, "chrome", {
  value: chromeMock,
  configurable: true,
});

describe("aiClient", () => {
  beforeEach(() => {
    Object.keys(storageData).forEach((key) => delete storageData[key]);
    storageData[SETTINGS_STORAGE_KEY] = {
      protectionEnabled: true,
      backendUrl: "http://localhost:8000",
      sensitivity: 0.75,
      nuditySensitivity: 0.75,
      violenceSensitivity: 0.75,
      categories: { nudity: true, violence: false, kissing: false, profanity: false, lgbtq: false },
    };
    global.fetch = jest.fn();
  });

  it("returns safe default and sets offline flag when fetch fails", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("connection refused"));

    const result = await analyzeImage(
      new Blob(["jpeg"], { type: "image/jpeg" }),
      0.75,
      "nudity"
    );

    expect(result.fromFallback).toBe(true);
    expect(result.backendOnline).toBe(false);
    expect(result.response).toMatchObject({
      category: "nudity",
      detected: false,
      confidence: 0,
      action: "ALLOW",
      model_loaded: false,
      detections: [],
    });

    await analyzeImage(new Blob(["jpeg"], { type: "image/jpeg" }), 0.75, "nudity");
    await analyzeImage(new Blob(["jpeg"], { type: "image/jpeg" }), 0.75, "nudity");

    const status = getBackendStatus();
    expect(status.online).toBe(false);
    expect(storageData[BACKEND_STATUS_STORAGE_KEY]).toMatchObject({
      online: false,
    });
  });

  it("returns parsed response and sets online flag on success", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          category: "nudity",
          detected: true,
          confidence: 0.9,
          action: "BLUR",
          model_loaded: true,
        }),
    });

    const result = await analyzeImage(
      new Blob(["jpeg"], { type: "image/jpeg" }),
      0.75,
      "nudity"
    );

    expect(result.fromFallback).toBe(false);
    expect(result.backendOnline).toBe(true);
    expect(result.response.confidence).toBe(0.9);
    expect(getBackendStatus().online).toBe(true);
  });

  it("returns null when response JSON is unparseable", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => "not json at all",
    });

    const result = await analyzeImage(
      new Blob(["jpeg"], { type: "image/jpeg" }),
      0.75,
      "nudity"
    );

    expect(result).toBeNull();
  });

  it("parses JSON wrapped in markdown fences", () => {
    const parsed = parseAnalyzeImageResponseText(
      '```json\n{"label":"NSFW","score":0.88,"detected":true,"action":"BLUR"}\n```'
    );

    expect(parsed).toMatchObject({ label: "NSFW", score: 0.88 });
  });

  it("never throws on HTTP error responses", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
    });

    await expect(
      analyzeImage(new Blob(["jpeg"], { type: "image/jpeg" }), 0.75, "nudity")
    ).resolves.toMatchObject({
      fromFallback: true,
      backendOnline: false,
    });
  });
});
