import { describe, expect, it } from "vitest";
import { controlForMidpoint, cubicPoints, curveBounds, curveMidpoint } from "./line-curve";

describe("curved lines", () => {
  const points = [0, 100, 200, 100] as const;

  it("puts the handle on the curve's middle and back", () => {
    expect(curveMidpoint(points)).toEqual([100, 100]);
    expect(curveMidpoint(points, [100, 0])).toEqual([100, 50]);
    expect(controlForMidpoint(points, [100, 50])).toEqual([100, 0]);
  });

  it("draws the quadratic as an equivalent cubic", () => {
    const cubic = cubicPoints(points, [100, 0]);
    expect(cubic[0]).toBe(0);
    expect(cubic[1]).toBe(100);
    expect(cubic[2]).toBeCloseTo(66.667, 3);
    expect(cubic[3]).toBeCloseTo(33.333, 3);
    expect(cubic[4]).toBeCloseTo(133.333, 3);
    expect(cubic[5]).toBeCloseTo(33.333, 3);
    expect(cubic.slice(6)).toEqual([200, 100]);
  });

  it("bounds the curve at its peak, not at the control point", () => {
    expect(curveBounds(points)).toEqual({ left: 0, top: 100, right: 200, bottom: 100 });
    expect(curveBounds(points, [100, 0])).toEqual({ left: 0, top: 50, right: 200, bottom: 100 });
  });
});
