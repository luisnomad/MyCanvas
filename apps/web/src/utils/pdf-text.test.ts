import { describe, expect, it } from "vitest";
import { arcPath, arcPoint, arcPointAtLength, arcSvgData, bandCap, curveArc, curveTextPad, curvedGlyphs, effectOffset, konvaArcLength, straightBands, textFallbackReason } from "./pdf-text";
import { pathBounds } from "./pdf-vector";

describe("curveArc", () => {
  it("is null for straight text", () => {
    expect(curveArc(100, 20, 0)).toBeNull();
  });

  it("arches on a circle below the text whose arc is as long as the text", () => {
    // curve 50 → Θ = π: a half circle of radius W/π.
    const arc = curveArc(314.159, 20, 50);
    expect(arc?.radius).toBeCloseTo(100, 2);
    expect(arc?.sweep).toBeCloseTo(Math.PI);
    expect(arc?.cx).toBeCloseTo(157.08, 2);
    // Center sits radius + 0.8·fontSize below the top: the peak (angle -π/2) is at y = 0.8·fontSize.
    expect(arc && arcPoint(arc, -Math.PI / 2).y).toBeCloseTo(16);
    // Starts at the left end, ends at the right end, at the same height.
    const start = arc ? arcPoint(arc, arc.startAngle) : { x: 0, y: 0 };
    const end = arc ? arcPoint(arc, arc.startAngle + arc.sweep) : { x: 0, y: 0 };
    expect(start.x).toBeCloseTo(57.08, 2);
    expect(end.x).toBeCloseTo(257.08, 2);
    expect(start.y).toBeCloseTo(end.y);
    expect(arc && konvaArcLength(arc)).toBeCloseTo(314.159, 0);
  });

  it("smiles on a circle above the text, read left to right", () => {
    const arc = curveArc(314.159, 20, -50);
    expect(arc?.sweep).toBeCloseTo(-Math.PI);
    const start = arc ? arcPoint(arc, arc.startAngle) : { x: 0, y: 0 };
    const end = arc ? arcPoint(arc, arc.startAngle + arc.sweep) : { x: 0, y: 0 };
    expect(start.x).toBeLessThan(end.x);
    // The ends sit at y ≈ 0.8·fontSize and the bottom of the smile below them.
    expect(start.y).toBeCloseTo(16);
    expect(arc && arcPoint(arc, Math.PI / 2).y).toBeGreaterThan(16);
  });

  it("measures length with 1° chords, just under the true arc", () => {
    const arc = curveArc(314.159, 20, 50); // half circle, radius 100
    const length = arc ? konvaArcLength(arc) : 0;
    expect(length).toBeLessThan(314.159);
    expect(length).toBeGreaterThan(314.1);
    expect(arc && arcPointAtLength(arc, length / 2, length).x).toBeCloseTo(arc?.cx ?? 0, 1);
  });

  it("stops just short of a full circle at curve 100, so the arc has two ends", () => {
    const arc = curveArc(600, 20, 100);
    expect(Math.abs(arc?.sweep ?? 0)).toBeLessThan(2 * Math.PI);
    const start = arc ? arcPoint(arc, arc.startAngle) : { x: 0, y: 0 };
    const end = arc ? arcPoint(arc, arc.startAngle + arc.sweep) : { x: 0, y: 0 };
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeGreaterThan(5);
    expect(arcSvgData(arc ?? { cx: 0, cy: 0, radius: 1, startAngle: 0, sweep: 1 })).toMatch(/ A [\d.]+ [\d.]+ 0 1 1 /);
  });

  it("pads only the end: the text keeps its start and its circle", () => {
    const plain = curveArc(300, 20, 40);
    const padded = curveArc(300, 20, 40, curveTextPad(300, 3));
    expect(padded?.startAngle).toBe(plain?.startAngle);
    expect(padded?.radius).toBe(plain?.radius);
    expect((padded?.sweep ?? 0) * (padded?.radius ?? 0) - (plain?.sweep ?? 0) * (plain?.radius ?? 0)).toBeCloseTo(3 + 2 + 0.6);
  });
});

describe("curvedGlyphs", () => {
  const arc = curveArc(300, 20, 50) ?? { cx: 0, cy: 0, radius: 1, startAngle: 0, sweep: 1 };
  const chars = [..."ABCDEFGHIJ"].map((text) => ({ text, width: 30 }));

  it("starts each glyph at its running offset on the arc and rotates it along its chord", () => {
    // A kerned string measures a hair narrower than its characters, which keeps the last glyph.
    const glyphs = curvedGlyphs(chars, 299, 0, arc);
    expect(glyphs.map((g) => g.text).join("")).toBe("ABCDEFGHIJ");
    const first = glyphs[0];
    const start = arcPoint(arc, arc.startAngle);
    expect(first?.x).toBeCloseTo(start.x);
    expect(first?.y).toBeCloseTo(start.y);
    // On an arch the first glyph leans right-and-up (negative y-down angle)…
    expect(first?.rotation ?? 0).toBeLessThan(0);
    // …and the middle glyphs sit level-ish while the last leans down.
    expect(Math.abs(glyphs[4]?.rotation ?? 1)).toBeLessThan(Math.abs(first?.rotation ?? 0));
    expect(glyphs[9]?.rotation ?? 0).toBeGreaterThan(0);
    // Every origin lies on the circle.
    for (const g of glyphs) {
      expect(Math.hypot(g.x - arc.cx, g.y - arc.cy)).toBeCloseTo(arc.radius, 6);
    }
  });

  it("drops the last glyph on an unpadded path, keeps it with the text pad", () => {
    // Full width equal to the sum: no slack; the 1° chords make the path a hair short.
    expect(curvedGlyphs(chars, 300, 0, arc)).toHaveLength(9);
    // Letter spacing pushes the last end past the path by more than the slack.
    expect(curvedGlyphs(chars, 299, 2, curveArc(300 + 9 * 2, 20, 50) ?? arc)).toHaveLength(9);
    // The editor and the PDF pad the path's end: every glyph stays.
    expect(curvedGlyphs(chars, 300, 0, curveArc(300, 20, 50, curveTextPad(300, 0)) ?? arc)).toHaveLength(10);
    expect(curvedGlyphs(chars, 299, 2, curveArc(318, 20, 50, curveTextPad(318, 2)) ?? arc)).toHaveLength(10);
    expect(curvedGlyphs(chars, 300, 0, curveArc(300, 20, 100, curveTextPad(300, 0)) ?? arc)).toHaveLength(10);
  });

  it("drops glyphs that start past the path", () => {
    const long = [..."ABCDEFGHIJKLMN"].map((text) => ({ text, width: 30 }));
    expect(curvedGlyphs(long, 419, 0, arc).length).toBeLessThanOrEqual(10);
  });
});

describe("arcPath", () => {
  it("traces the arc with cubics inside the circle's box", () => {
    const arc = curveArc(314.159, 20, 50) ?? { cx: 0, cy: 0, radius: 1, startAngle: 0, sweep: 1 };
    const path = arcPath(arc);
    expect(path[0]?.op).toBe("M");
    expect(path.filter((c) => c.op === "C").length).toBeGreaterThanOrEqual(2);
    const [x0, y0, x1] = pathBounds(path);
    expect(x0).toBeCloseTo(arc.cx - arc.radius, 0);
    expect(x1).toBeCloseTo(arc.cx + arc.radius, 0);
    expect(y0).toBeCloseTo(16, 0);
  });
});

describe("effects", () => {
  it("offsets echo and glitch along their angle", () => {
    const { dx, dy } = effectOffset({ type: "echo", color: "#000", distance: 10, angle: 90 });
    expect(dx).toBeCloseTo(0);
    expect(dy).toBeCloseTo(10);
    expect(effectOffset({ type: "outline", color: "#000", thickness: 2 })).toEqual({ dx: 0, dy: 0 });
  });

  it("lays a band under each straight line, aligned like the text", () => {
    const effect = { type: "background" as const, color: "#ff0", spread: 12, roundness: 40, opacity: 1 };
    const bands = straightBands([100, 60], { wrapWidth: 0, align: "center", fontSize: 20, lineHeight: 1.2 }, effect);
    expect(bands).toHaveLength(2);
    expect(bands[0]).toEqual({ x0: 0, y: 12, x1: 100, width: 36, cap: "square" });
    expect(bands[1]).toEqual({ x0: 20, y: 36, x1: 80, width: 36, cap: "square" });
    expect(straightBands([60], { wrapWidth: 200, align: "right", fontSize: 20, lineHeight: 1 }, effect)[0]?.x0).toBe(140);
    expect(bandCap(60)).toBe("round");
    expect(bandCap(10)).toBe("butt");
  });
});

describe("textFallbackReason", () => {
  const base = { id: "t", name: "t", type: "text" as const, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true, text: "a", fontFamily: "Inter", fontSize: 20, fontStyle: "normal", fill: "#000000", align: "left" as const, lineHeight: 1.2, letterSpacing: 0, wrapWidth: 0, shadow: { enabled: false, color: "#000", blur: 0, offsetX: 0, offsetY: 0, opacity: 0 }, stroke: { enabled: false, color: "#000", width: 0 } };
  it("keeps plain, outlined, echoed, glitched and banded text as text", () => {
    expect(textFallbackReason(base)).toBeNull();
    expect(textFallbackReason({ ...base, effect: { type: "outline", color: "#fff", thickness: 3 } })).toBeNull();
    expect(textFallbackReason({ ...base, curve: 40, effect: { type: "background", color: "#ff0", spread: 10, roundness: 50, opacity: 1 } })).toBeNull();
  });
  it("keeps soft effects as text (their glow or shadow becomes a picture underneath) and sends unreadable colors to raster", () => {
    expect(textFallbackReason({ ...base, effect: { type: "glow", color: "#ff0", spread: 10, strength: 50 } })).toBeNull();
    expect(textFallbackReason({ ...base, effect: { type: "shadow", color: "#000", distance: 5, angle: 45, blur: 8, opacity: 0.5 } })).toBeNull();
    expect(textFallbackReason({ ...base, fill: "hsl(1,1%,1%)" })).toBe("fill color");
    expect(textFallbackReason({ ...base, curve: 100 })).toBeNull();
  });
});
