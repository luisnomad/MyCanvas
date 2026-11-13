import { describe, expect, it } from "vitest";
import { type LineLayer, type RectLayer, type ShapeLayer } from "@mycanvas/shared";
import { exportPixelRatio } from "./export-size";
import {
  type PathCommand,
  applyMatrix,
  backgroundShape,
  gradientShading,
  ellipsePath,
  layerMatrix,
  parseCssColor,
  pathBounds,
  pdfLayerMatrix,
  rectPath,
  shapeLayerPath,
  svgPathCommands,
  vectorFallbackReason,
  vectorShapeForLayer,
} from "./pdf-vector";

const noShadow = { enabled: false, color: "#000000", blur: 0, offsetX: 0, offsetY: 0, opacity: 0 };
const noStroke = { enabled: false, color: "#000000", width: 0 };
const base = { id: "a", name: "a", x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true };

function rect(extra: Partial<RectLayer> = {}): RectLayer {
  return { ...base, type: "rect", width: 100, height: 50, fill: "#ff0000", cornerRadius: 0, stroke: noStroke, shadow: noShadow, ...extra };
}
function shape(extra: Partial<ShapeLayer> = {}): ShapeLayer {
  return { ...base, type: "shape", shape: "circle", width: 100, height: 60, fill: "#00ff00", stroke: noStroke, shadow: noShadow, ...extra };
}
function line(extra: Partial<LineLayer> = {}): LineLayer {
  return { ...base, type: "line", points: [0, 0, 200, 0], strokeColor: "#0000ff", strokeWidth: 8, lineCap: "round", shadow: noShadow, ...extra };
}

/** Samples a path's outline (curves at t = 0.5 steps) for geometric checks. */
function samplePoints(path: PathCommand[], steps = 8): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let current = { x: 0, y: 0 };
  for (const command of path) {
    if (command.op === "M" || command.op === "L") {
      current = { x: command.x, y: command.y };
      points.push(current);
    } else if (command.op === "C") {
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const u = 1 - t;
        points.push({
          x: u * u * u * current.x + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t * t * t * command.x,
          y: u * u * u * current.y + 3 * u * u * t * command.y1 + 3 * u * t * t * command.y2 + t * t * t * command.y,
        });
      }
      current = { x: command.x, y: command.y };
    }
  }
  return points;
}

describe("parseCssColor", () => {
  it("reads hex, rgb(a) and names", () => {
    expect(parseCssColor("#ff8000")).toEqual({ r: 1, g: 128 / 255, b: 0, a: 1 });
    expect(parseCssColor("#f00")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseCssColor("#00000080")?.a).toBeCloseTo(128 / 255);
    expect(parseCssColor("rgba(255, 0, 0, 0.5)")).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor("rgb(0 255 0)")).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(parseCssColor("transparent")?.a).toBe(0);
  });

  it("rejects what it can't read", () => {
    expect(parseCssColor("hsl(0, 100%, 50%)")).toBeNull();
    expect(parseCssColor("#12345")).toBeNull();
    expect(parseCssColor("rebeccapurple")).toBeNull();
  });
});

describe("matrices", () => {
  it("matches Konva's translate · rotate · scale", () => {
    const m = layerMatrix({ x: 10, y: 20, rotation: 90, scaleX: 2, scaleY: 3 });
    // Local (1, 0) → scaled to (2, 0) → rotated 90° (y down) to (0, 2) → +offset.
    const p = applyMatrix(m, 1, 0);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(22);
    const q = applyMatrix(m, 0, 1);
    expect(q.x).toBeCloseTo(7);
    expect(q.y).toBeCloseTo(20);
  });

  it("flips into PDF space with y up, in points", () => {
    const m = pdfLayerMatrix(layerMatrix({ x: 96, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }), 960, 0.75);
    const topLeft = applyMatrix(m, 0, 0);
    expect(topLeft.x).toBeCloseTo(72);
    expect(topLeft.y).toBeCloseTo(720);
    const below = applyMatrix(m, 0, 96);
    expect(below.y).toBeCloseTo(648);
  });

  it("keeps a negative scale (flip) as a mirrored matrix", () => {
    const m = layerMatrix({ x: 100, y: 0, rotation: 0, scaleX: -1, scaleY: 1 });
    expect(applyMatrix(m, 30, 0).x).toBeCloseTo(70);
  });
});

describe("rectPath", () => {
  it("is a plain rectangle without radius", () => {
    expect(rectPath(100, 50, 0)).toEqual([
      { op: "M", x: 0, y: 0 },
      { op: "L", x: 100, y: 0 },
      { op: "L", x: 100, y: 50 },
      { op: "L", x: 0, y: 50 },
      { op: "Z" },
    ]);
  });

  it("rounds corners on true quarter circles, clamped like Konva", () => {
    const path = rectPath(100, 40, 50);
    // Radius clamps to half the shorter side (20).
    expect(path[0]).toEqual({ op: "M", x: 20, y: 0 });
    expect(path.filter((c) => c.op === "C")).toHaveLength(4);
    // Corner points lie on their corner circle: centers (20, 20) and (80, 20).
    for (const p of samplePoints(path, 16)) {
      if (p.x < 20 || p.x > 80) {
        const cx = p.x < 20 ? 20 : 80;
        expect(Math.abs(Math.hypot(p.x - cx, p.y - 20) - 20)).toBeLessThan(0.01);
      }
    }
    expect(pathBounds(path)).toEqual([0, 0, 100, 40]);
  });
});

describe("ellipsePath", () => {
  it("stays on the ellipse within Bézier tolerance", () => {
    const path = ellipsePath(50, 30, 50, 30);
    expect(path[0]).toEqual({ op: "M", x: 100, y: 30 });
    expect(path.filter((c) => c.op === "C")).toHaveLength(4);
    for (const p of samplePoints(path, 16)) {
      const r = Math.hypot((p.x - 50) / 50, (p.y - 30) / 30);
      expect(Math.abs(r - 1)).toBeLessThan(0.0003);
    }
    expect(pathBounds(path)).toEqual([0, 0, 100, 60]);
  });

  it("runs clockwise (y down) from angle 0, like canvas arc()", () => {
    const first = ellipsePath(0, 0, 10, 10)[1];
    expect(first?.op === "C" && first.y).toBeCloseTo(10);
  });
});

describe("svgPathCommands", () => {
  it("turns quadratics into exact cubics", () => {
    const path = svgPathCommands("M 0 0 Q 10 20 20 0 Z");
    const cubic = path?.[1];
    expect(path).toHaveLength(3);
    expect(cubic?.op).toBe("C");
    if (cubic?.op === "C") {
      expect(cubic.x1).toBeCloseTo(20 / 3);
      expect(cubic.y1).toBeCloseTo(40 / 3);
      expect(cubic.x2).toBeCloseTo(40 / 3);
      expect(cubic.y2).toBeCloseTo(40 / 3);
      expect([cubic.x, cubic.y]).toEqual([20, 0]);
    }
    // Midpoint of the quadratic: (10, 10).
    const mid = samplePoints(path ?? [], 2)[1];
    expect(mid?.x).toBeCloseTo(10);
    expect(mid?.y).toBeCloseTo(10);
  });

  it("reads exponents and negatives, rejects unknown commands", () => {
    expect(svgPathCommands("M -1e-3 2.5 L .5 -4 Z")).toEqual([
      { op: "M", x: -0.001, y: 2.5 },
      { op: "L", x: 0.5, y: -4 },
      { op: "Z" },
    ]);
    expect(svgPathCommands("M 0 0 A 1 1 0 0 1 2 2")).toBeNull();
  });
});

describe("shapeLayerPath", () => {
  it("draws every shape kind inside its box", () => {
    for (const kind of ["triangle", "hexagon", "circle", "semicircle", "star"] as const) {
      const path = shapeLayerPath({ shape: kind, width: 120, height: 80, cornerRadius: 0 });
      expect(path, kind).not.toBeNull();
      const [x0, y0, x1, y1] = pathBounds(path ?? []);
      expect(x0, kind).toBeCloseTo(0);
      expect(y0, kind).toBeCloseTo(0);
      expect(x1, kind).toBeCloseTo(120);
      expect(y1, kind).toBeCloseTo(80);
    }
  });

  it("keeps a sharp triangle's corners", () => {
    expect(shapeLayerPath({ shape: "triangle", width: 100, height: 100, cornerRadius: 0 })).toEqual([
      { op: "M", x: 50, y: 0 },
      { op: "L", x: 100, y: 100 },
      { op: "L", x: 0, y: 100 },
      { op: "Z" },
    ]);
  });

  it("rounds star corners with curves", () => {
    const path = shapeLayerPath({ shape: "star", width: 100, height: 100, cornerRadius: 6 }) ?? [];
    expect(path.filter((c) => c.op === "C")).toHaveLength(10);
  });
});

describe("vectorShapeForLayer", () => {
  it("draws a solid rect with stroke", () => {
    const v = vectorShapeForLayer(rect({ x: 5, y: 6, stroke: { enabled: true, color: "#000000", width: 4 } }));
    expect(v?.fill).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(v?.stroke).toEqual({ color: { r: 0, g: 0, b: 0, a: 1 }, width: 4, cap: "butt" });
    expect(v?.matrix).toEqual([1, 0, -0, 1, 5, 6]);
    expect(v?.group).toBe(false);
  });

  it("groups fill and stroke under opacity like Konva's perfect draw", () => {
    const v = vectorShapeForLayer(shape({ opacity: 0.5, stroke: { enabled: true, color: "#000000", width: 4 } }));
    expect(v?.group).toBe(true);
    expect(vectorShapeForLayer(shape({ opacity: 0.5 }))?.group).toBe(false);
  });

  it("ignores disabled or zero-width strokes", () => {
    expect(vectorShapeForLayer(rect({ stroke: { enabled: true, color: "#000", width: 0 } }))?.stroke).toBeNull();
    expect(vectorShapeForLayer(rect({ stroke: { enabled: false, color: "#000", width: 5 } }))?.stroke).toBeNull();
  });

  it("draws a line with its cap and width", () => {
    const v = vectorShapeForLayer(line({ rotation: 30, opacity: 0.4 }));
    expect(v?.path).toEqual([{ op: "M", x: 0, y: 0 }, { op: "L", x: 200, y: 0 }]);
    expect(v?.stroke?.cap).toBe("round");
    expect(v?.stroke?.width).toBe(8);
    expect(v?.fill).toBeNull();
    expect(v?.opacity).toBe(0.4);
  });

  it("falls back to raster for per-stop alpha gradients, shadows and unreadable colors", () => {
    const gradient = { type: "linear" as const, angle: 0, stops: [{ offset: 0, color: "#00000080" }, { offset: 1, color: "#fff" }] };
    expect(vectorFallbackReason(rect({ gradient }))).toBe("gradient");
    expect(vectorShapeForLayer(shape({ gradient }))).toBeNull();
    expect(vectorShapeForLayer(line({ shadow: { ...noShadow, enabled: true, opacity: 0.5, blur: 4 } }))).toBeNull();
    expect(vectorShapeForLayer(rect({ fill: "hsl(10, 50%, 50%)" }))).toBeNull();
    // A one-stop gradient isn't drawn by the editor either: solid fill.
    expect(vectorShapeForLayer(rect({ gradient: { ...gradient, stops: [{ offset: 0, color: "#000" }] } }))).not.toBeNull();
    // An enabled shadow with zero opacity paints nothing.
    expect(vectorShapeForLayer(rect({ shadow: { ...noShadow, enabled: true, opacity: 0 } }))).not.toBeNull();
  });
});

describe("exportPixelRatio", () => {
  it("reads scales and widths", () => {
    expect(exportPixelRatio("s:4", 0, 1080, 1080)).toEqual({ ratio: 4, capped: false });
    expect(exportPixelRatio("w:3840", 0, 1080, 1080).ratio).toBeCloseTo(3840 / 1080);
    expect(exportPixelRatio("custom", 2000, 1000, 500)).toEqual({ ratio: 2, capped: false });
  });

  it("caps the longest side at 16,000 px", () => {
    expect(exportPixelRatio("custom", 50000, 1000, 2000)).toEqual({ ratio: 8, capped: true });
    expect(exportPixelRatio("s:4", 0, 5000, 1000)).toEqual({ ratio: 3.2, capped: true });
  });

  it("treats bad input as 1x", () => {
    expect(exportPixelRatio("custom", 0, 1000, 1000).ratio).toBe(1);
  });
});

describe("gradientShading", () => {
  const stops = [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }];

  it("runs a linear gradient through the box center along the angle, like gradientFillProps", () => {
    expect(gradientShading({ type: "linear", angle: 0, stops }, 200, 100)?.coords).toEqual([0, 50, 200, 50]);
    const down = gradientShading({ type: "linear", angle: 90, stops }, 200, 100)?.coords ?? [];
    expect(down.map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([100, 0, 100, 100]);
    // Ellipse-style origin at (-w/2, -h/2): the center sits at (0, 0).
    expect(gradientShading({ type: "linear", angle: 0, stops }, 200, 100, -100, -50)?.coords).toEqual([-100, 0, 100, 0]);
  });

  it("runs a radial gradient from the center to the half diagonal", () => {
    const spec = gradientShading({ type: "radial", angle: 0, stops }, 300, 400);
    expect(spec?.type).toBe("radial");
    expect(spec?.coords).toEqual([150, 200, 0, 150, 200, 250]);
  });

  it("keeps opaque stop colors and one shared alpha", () => {
    const spec = gradientShading({ type: "linear", angle: 0, stops: [{ offset: 0, color: "rgba(255,0,0,0.5)" }, { offset: 1, color: "#0000ff80" }] }, 10, 10);
    expect(spec?.alpha).toBeCloseTo(0.5, 1);
    expect(spec?.stops.every((stop) => stop.color.a === 1)).toBe(true);
    expect(gradientShading({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#0000ff80" }] }, 10, 10)).toBeNull();
    expect(gradientShading({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#f00" }] }, 10, 10)).toBeNull();
    expect(gradientShading({ type: "linear", angle: 0, stops: [{ offset: 1, color: "#f00" }, { offset: 0, color: "#00f" }] }, 10, 10)).toBeNull();
  });

  it("makes gradient shapes vector", () => {
    const v = vectorShapeForLayer(rect({ gradient: { type: "linear", angle: 0, stops } }));
    expect(v?.fill).toBeNull();
    expect(v?.gradient?.type).toBe("axial");
  });
});

describe("backgroundShape", () => {
  it("is a solid rectangle, a shading, or nothing", () => {
    const solid = backgroundShape("#ffffff", undefined, 100, 50);
    expect(solid?.fill).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(pathBounds(solid?.path ?? [])).toEqual([0, 0, 100, 50]);
    const gradient = backgroundShape("#ffffff", { type: "radial", angle: 0, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] }, 100, 50);
    expect(gradient?.fill).toBeNull();
    expect(gradient?.gradient?.type).toBe("radial");
    expect(backgroundShape("transparent", undefined, 100, 50)).toBeNull();
  });
});
