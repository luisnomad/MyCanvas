import { describe, expect, it } from "vitest";
import { clampContent, coverContent, frameContentBox, recoverContent } from "./frame-content";

describe("frameContentBox", () => {
  it("is the frame's own box when the photo turns with the frame", () => {
    expect(frameContentBox({ width: 200, height: 100, rotation: 37 })).toEqual({ width: 200, height: 100, angle: 0 });
  });

  it("swaps width and height for a quarter turn with the photo kept upright", () => {
    expect(frameContentBox({ width: 200, height: 100, rotation: 90, contentRotation: 0 })).toEqual({ width: 100, height: 200, angle: -90 });
  });

  it("covers the turned frame at other angles", () => {
    const box = frameContentBox({ width: 100, height: 100, rotation: 45, contentRotation: 0 });
    expect(box.width).toBeCloseTo(141.421356, 5);
    expect(box.height).toBeCloseTo(141.421356, 5);
  });

  it("is the frame's box when the kept angle equals the frame's", () => {
    expect(frameContentBox({ width: 200, height: 100, rotation: 30, contentRotation: 30 })).toEqual({ width: 200, height: 100, angle: 0 });
  });
});

describe("content fit", () => {
  it("covers, clamps and re-covers keeping the visible center", () => {
    const cover = coverContent("a.png", 400, 200, 100, 200);
    expect(cover).toEqual({ asset: "a.png", scale: 1, offsetX: -150, offsetY: 0 });
    expect(clampContent({ ...cover, offsetX: 50 }, 400, 200, 100, 200).offsetX).toBe(0);
    expect(recoverContent(cover, 400, 200, 100, 200, 200, 100)).toEqual({ asset: "a.png", scale: 0.5, offsetX: 0, offsetY: 0 });
  });
});
