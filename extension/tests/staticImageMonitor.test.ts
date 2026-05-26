/**
 * @jest-environment jsdom
 */

import {
  IMAGE_ID_OFFSET,
  isStaticImageId,
} from "../src/content/imageMonitor";

describe("staticImageMonitor", () => {
  it("uses IMAGE_ID_OFFSET for image element ids", () => {
    expect(IMAGE_ID_OFFSET).toBe(1_000_000);
    expect(isStaticImageId(1_000_001)).toBe(true);
    expect(isStaticImageId(42)).toBe(false);
  });
});
