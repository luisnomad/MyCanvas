import { type GradientFill, type Layer, type LineLayer, type RectLayer, type ShadowEffect, type ShapeLayer, type StrokeEffect } from "@mycanvas/shared";
import { roundedPolygonPath, shapePoints } from "./rounded-path";

/**
 * Vector geometry for PDF export (pure: no Konva, no pdf-lib).
 *
 * Turns rect, shape and line layers into paths in the layer's local space
 * (y down, like the editor), with the same geometry LayerNode draws through
 * Konva, plus the layer transform and paint. Anything that can't be drawn
 * exactly (gradients, shadows, unknown colors) returns null so the caller
 * rasterizes that layer instead.
 */

export type PathCommand =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | { op: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: "Z" };

/** Channels 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 2D affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export interface VectorStroke {
  color: Rgba;
  width: number;
  cap: "butt" | "round" | "square";
  /** Default miter, as canvas. */
  join?: "miter" | "round" | "bevel";
}

/** A gradient as a PDF shading, in the shape's local space (y down). */
export interface ShadingSpec {
  type: "axial" | "radial";
  /** Axial: [x0, y0, x1, y1]; radial: [x0, y0, r0, x1, y1, r1]. */
  coords: number[];
  /** Two or more stops, offsets ascending in 0…1. Colors are opaque; see `alpha`. */
  stops: { offset: number; color: Rgba }[];
  /** The stops' shared alpha (a per-stop alpha can't be a plain shading). */
  alpha: number;
}

export interface VectorShape {
  /** Layer-local → design px (Konva's node transform). */
  matrix: Matrix;
  path: PathCommand[];
  fill: Rgba | null;
  /** Painted inside the path instead of `fill` when present. */
  gradient?: ShadingSpec;
  stroke: VectorStroke | null;
  /** Layer opacity, 0–1. */
  opacity: number;
  /**
   * Fill and stroke drawn together under opacity < 1: Konva paints both
   * opaque into a buffer and composites that once (perfectDraw), so the
   * stroke's inner half doesn't double over the fill. A PDF transparency
   * group does the same.
   */
  group: boolean;
}

/** Konva's node transform: translate · rotate · scale (no offset or skew). */
export function layerMatrix(layer: Pick<Layer, "x" | "y" | "rotation" | "scaleX" | "scaleY">): Matrix {
  const radians = (layer.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos * layer.scaleX, sin * layer.scaleX, -sin * layer.scaleY, cos * layer.scaleY, layer.x, layer.y];
}

/** `outer ∘ inner`: applies `inner` first. */
export function multiplyMatrix(outer: Matrix, inner: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * The PDF `cm` for a layer: design px with y down → PDF points with y up
 * on a page `designHeight` px tall.
 */
export function pdfLayerMatrix(layer: Matrix, designHeight: number, pointsPerPx: number): Matrix {
  const k = pointsPerPx;
  return multiplyMatrix([k, 0, 0, -k, 0, k * designHeight], layer);
}

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 1, g: 1, b: 1, a: 1 },
};

/** Parses the CSS colors layers use (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), a few names). */
export function parseCssColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  const named = NAMED[value];
  if (named) {
    return { ...named };
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 || hex.length === 4 ? [...hex].map((ch) => ch + ch).join("") : hex;
    if (full.length !== 6 && full.length !== 8) {
      return null;
    }
    const channel = (index: number) => parseInt(full.slice(index, index + 2), 16) / 255;
    return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) : 1 };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(value)?.[1];
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) {
      return null;
    }
    const nums = parts.map((part, index) => {
      const n = parseFloat(part);
      if (!Number.isFinite(n)) {
        return NaN;
      }
      if (index === 3) {
        return part.endsWith("%") ? n / 100 : n;
      }
      return part.endsWith("%") ? n / 100 : n / 255;
    });
    if (nums.some((n) => Number.isNaN(n))) {
      return null;
    }
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { r: clamp(nums[0] ?? 0), g: clamp(nums[1] ?? 0), b: clamp(nums[2] ?? 0), a: clamp(nums[3] ?? 1) };
  }
  return null;
}

/** Cubic Bézier segments for a circular arc (≤ 90° each), clockwise in y-down space when a1 > a0. */
export function arcCommands(cx: number, cy: number, r: number, a0: number, a1: number): PathCommand[] {
  const commands: PathCommand[] = [];
  const segments = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const step = (a1 - a0) / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < segments; i += 1) {
    const s = a0 + i * step;
    const e = s + step;
    const cs = Math.cos(s);
    const ss = Math.sin(s);
    const ce = Math.cos(e);
    const se = Math.sin(e);
    commands.push({
      op: "C",
      x1: cx + r * (cs - k * ss),
      y1: cy + r * (ss + k * cs),
      x2: cx + r * (ce + k * se),
      y2: cy + r * (se - k * ce),
      x: cx + r * ce,
      y: cy + r * se,
    });
  }
  return commands;
}

/** Konva.Rect: plain rect, or Util.drawRoundedRectPath with the radius clamped to half the shorter side. */
export function rectPath(width: number, height: number, cornerRadius: number): PathCommand[] {
  if (!(cornerRadius > 0)) {
    return [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: width, y: 0 },
      { op: "L", x: width, y: height },
      { op: "L", x: 0, y: height },
      { op: "Z" },
    ];
  }
  const w = Math.abs(width);
  const h = Math.abs(height);
  const x0 = width < 0 ? width : 0;
  const y0 = height < 0 ? height : 0;
  const r = Math.min(cornerRadius, w / 2, h / 2);
  const half = Math.PI / 2;
  return [
    { op: "M", x: x0 + r, y: y0 },
    { op: "L", x: x0 + w - r, y: y0 },
    ...arcCommands(x0 + w - r, y0 + r, r, 3 * half, 4 * half),
    { op: "L", x: x0 + w, y: y0 + h - r },
    ...arcCommands(x0 + w - r, y0 + h - r, r, 0, half),
    { op: "L", x: x0 + r, y: y0 + h },
    ...arcCommands(x0 + r, y0 + h - r, r, half, 2 * half),
    { op: "L", x: x0, y: y0 + r },
    ...arcCommands(x0 + r, y0 + r, r, 2 * half, 3 * half),
    { op: "Z" },
  ];
}

/** Konva.Ellipse at (cx, cy): starts at angle 0 and runs clockwise (y down), like canvas arc(). */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
  const circle = arcCommands(0, 0, 1, 0, 2 * Math.PI);
  const map = (x: number, y: number) => ({ x: cx + x * rx, y: cy + y * ry });
  const commands: PathCommand[] = [{ op: "M", ...map(1, 0) }];
  for (const command of circle) {
    if (command.op === "C") {
      const p1 = map(command.x1, command.y1);
      const p2 = map(command.x2, command.y2);
      const p = map(command.x, command.y);
      commands.push({ op: "C", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
    }
  }
  commands.push({ op: "Z" });
  return commands;
}

/**
 * Parses the M/L/Q/Z SVG paths roundedPolygonPath() emits (what Konva.Path
 * draws for polygon shapes). Quadratics become their exact cubic equivalents.
 */
export function svgPathCommands(d: string): PathCommand[] | null {
  const tokens = d.match(/[MLQZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const commands: PathCommand[] = [];
  let index = 0;
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  const num = () => {
    const token = tokens[index];
    index += 1;
    const n = token === undefined ? NaN : Number(token);
    return n;
  };
  while (index < tokens.length) {
    const op = tokens[index]?.toUpperCase();
    index += 1;
    if (op === "M" || op === "L") {
      const x = num();
      const y = num();
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      commands.push({ op, x, y });
      current = { x, y };
      if (op === "M") {
        start = { x, y };
      }
    } else if (op === "Q") {
      const qx = num();
      const qy = num();
      const x = num();
      const y = num();
      if (![qx, qy, x, y].every(Number.isFinite)) {
        return null;
      }
      commands.push({
        op: "C",
        x1: current.x + (2 / 3) * (qx - current.x),
        y1: current.y + (2 / 3) * (qy - current.y),
        x2: x + (2 / 3) * (qx - x),
        y2: y + (2 / 3) * (qy - y),
        x,
        y,
      });
      current = { x, y };
    } else if (op === "Z") {
      commands.push({ op: "Z" });
      current = start;
    } else {
      return null;
    }
  }
  return commands;
}

/** Path of a shape layer, in its local box (0,0)–(width,height), as LayerNode draws it. */
export function shapeLayerPath(layer: Pick<ShapeLayer, "shape" | "width" | "height" | "cornerRadius">): PathCommand[] | null {
  const { width: w, height: h } = layer;
  switch (layer.shape) {
    case "circle":
      return ellipsePath(w / 2, h / 2, w / 2, h / 2);
    case "triangle":
    case "hexagon":
    case "star":
    case "semicircle":
      return svgPathCommands(roundedPolygonPath(shapePoints(layer.shape, w, h), layer.cornerRadius ?? 0));
    default:
      return null;
  }
}

/**
 * The gradient as Konva's gradientFillProps paints it across a w×h box at
 * (originX, originY) in the shape's local space: a linear gradient runs
 * through the box center along `angle`, its stops spanning the box's
 * extent in that direction; a radial one runs from the center to the
 * box's half diagonal. Null when a stop color can't be read or the stops
 * don't share one alpha.
 */
export function gradientShading(gradient: GradientFill | undefined, w: number, h: number, originX = 0, originY = 0): ShadingSpec | null {
  if (!gradient || gradient.stops.length < 2) {
    return null;
  }
  const stops: ShadingSpec["stops"] = [];
  let alpha: number | null = null;
  for (const stop of gradient.stops) {
    const color = parseCssColor(stop.color);
    if (!color || !Number.isFinite(stop.offset)) {
      return null;
    }
    if (alpha !== null && Math.abs(color.a - alpha) > 0.01) {
      return null;
    }
    alpha = color.a;
    stops.push({ offset: Math.min(1, Math.max(0, stop.offset)), color: { ...color, a: 1 } });
  }
  for (let i = 1; i < stops.length; i += 1) {
    if ((stops[i]?.offset ?? 0) < (stops[i - 1]?.offset ?? 0)) {
      return null;
    }
  }
  const cx = originX + w / 2;
  const cy = originY + h / 2;
  if (gradient.type === "radial") {
    return { type: "radial", coords: [cx, cy, 0, cx, cy, Math.hypot(w, h) / 2], stops, alpha: alpha ?? 1 };
  }
  const radians = (gradient.angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return { type: "axial", coords: [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half], stops, alpha: alpha ?? 1 };
}

/** A shadow Konva would actually paint. */
export function shadowVisible(shadow: ShadowEffect | undefined): boolean {
  if (!shadow?.enabled || !(shadow.opacity > 0)) {
    return false;
  }
  const color = parseCssColor(shadow.color);
  return color === null || color.a > 0;
}

/** Konva hasStroke(): enabled, non-zero width and a color. Null color = unparseable. */
function strokeOf(stroke: Pick<StrokeEffect, "enabled" | "color" | "width">, cap: VectorStroke["cap"]): { stroke: VectorStroke | null; ok: boolean } {
  if (!stroke.enabled || !stroke.width || !stroke.color) {
    return { stroke: null, ok: true };
  }
  const color = parseCssColor(stroke.color);
  if (!color) {
    return { stroke: null, ok: false };
  }
  return { stroke: { color, width: stroke.width, cap }, ok: true };
}

/** Why a layer can't be a vector slice, or null when it can. */
export function vectorFallbackReason(layer: Layer): string | null {
  if (layer.type !== "rect" && layer.type !== "shape" && layer.type !== "line") {
    return "not a vector type yet";
  }
  // A visible shadow is not a reason: the exporter draws it as its own picture under the shape.
  if (layer.type !== "line" && layer.gradient && layer.gradient.stops.length >= 2 && !gradientShading(layer.gradient, layer.width, layer.height)) {
    return "gradient";
  }
  return null;
}

function fillShape(layer: RectLayer | ShapeLayer, path: PathCommand[]): VectorShape | null {
  const fill = layer.fill ? parseCssColor(layer.fill) : null;
  if (layer.fill && !fill) {
    return null;
  }
  const { stroke, ok } = strokeOf(layer.stroke, "butt");
  if (!ok) {
    return null;
  }
  const gradient = gradientShading(layer.gradient, layer.width, layer.height) ?? undefined;
  const opacity = Math.min(1, Math.max(0, layer.opacity));
  const painted = gradient ? gradient.alpha > 0 : Boolean(fill && fill.a > 0);
  return {
    matrix: layerMatrix(layer),
    path,
    fill: !gradient && fill && fill.a > 0 ? fill : null,
    ...(gradient && gradient.alpha > 0 ? { gradient } : {}),
    stroke: stroke && stroke.color.a > 0 ? stroke : null,
    opacity,
    group: Boolean(painted && stroke && stroke.color.a > 0 && opacity < 1),
  };
}

function lineShape(layer: LineLayer): VectorShape | null {
  const [x1, y1, x2, y2] = layer.points;
  const { stroke, ok } = strokeOf({ enabled: true, color: layer.strokeColor, width: layer.strokeWidth }, layer.lineCap);
  if (!ok) {
    return null;
  }
  return {
    matrix: layerMatrix(layer),
    path: [
      { op: "M", x: x1, y: y1 },
      { op: "L", x: x2, y: y2 },
    ],
    fill: null,
    stroke: stroke && stroke.color.a > 0 ? stroke : null,
    opacity: Math.min(1, Math.max(0, layer.opacity)),
    group: false,
  };
}

/** The layer as vector geometry and paint, or null when it must be rasterized. */
export function vectorShapeForLayer(layer: Layer): VectorShape | null {
  if (vectorFallbackReason(layer) !== null) {
    return null;
  }
  switch (layer.type) {
    case "rect":
      return fillShape(layer, rectPath(layer.width, layer.height, layer.cornerRadius));
    case "shape": {
      const path = shapeLayerPath(layer);
      return path ? fillShape(layer, path) : null;
    }
    case "line":
      return lineShape(layer);
    default:
      return null;
  }
}

/**
 * The page background as a vector shape: a solid color rectangle or a
 * gradient shading over the page. Null when transparent or unreadable.
 */
export function backgroundShape(background: string, gradient: GradientFill | undefined, width: number, height: number): VectorShape | null {
  if (background === "transparent") {
    return null;
  }
  const shading = gradientShading(gradient, width, height);
  const fill = shading ? null : parseCssColor(background);
  if (!shading && !fill) {
    return null;
  }
  return {
    matrix: [1, 0, 0, 1, 0, 0],
    path: rectPath(width, height, 0),
    fill: fill && fill.a > 0 ? fill : null,
    ...(shading && shading.alpha > 0 ? { gradient: shading } : {}),
    stroke: null,
    opacity: 1,
    group: false,
  };
}

/**
 * Bounds of a path in its own space (control points included, so it
 * contains the curve), grown by `pad`. Used for a transparency group's BBox.
 */
export function pathBounds(path: PathCommand[], pad = 0): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const command of path) {
    if (command.op === "M" || command.op === "L") {
      add(command.x, command.y);
    } else if (command.op === "C") {
      add(command.x1, command.y1);
      add(command.x2, command.y2);
      add(command.x, command.y);
    }
  }
  if (minX === Infinity) {
    return [0, 0, 0, 0];
  }
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}
