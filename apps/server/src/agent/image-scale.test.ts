import { describe, expect, it } from "vitest";
import { imageScale } from "./image-scale";

describe("imageScale", () => {
  it("takes a scale up to 4x", () => {
    expect(imageScale({}, 1080, 1350)).toBe(1);
    expect(imageScale({ scale: "4" }, 1080, 1350)).toBe(4);
    expect(imageScale({ scale: "4.5" }, 1080, 1350)).toBeNull();
    expect(imageScale({ scale: "0" }, 1080, 1350)).toBeNull();
  });

  it("turns an output width into a scale, which wins over scale", () => {
    expect(imageScale({ width: "3840" }, 1080, 1350)).toBeCloseTo(3840 / 1080);
    expect(imageScale({ width: "2160", scale: "1" }, 1080, 1350)).toBe(2);
    expect(imageScale({ width: "abc" }, 1080, 1350)).toBeNull();
  });

  it("refuses outputs above 16000 px on a side", () => {
    expect(imageScale({ width: "16000" }, 1080, 1080)).not.toBeNull();
    expect(imageScale({ width: "12800" }, 1080, 1920)).toBeNull();
    expect(imageScale({ scale: "4" }, 5000, 3000)).toBeNull();
  });
});
