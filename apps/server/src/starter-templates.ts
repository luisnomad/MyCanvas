import {
  type Design,
  type FrameLayer,
  type FrameShape,
  type Layer,
  type LineLayer,
  type RectLayer,
  type ShapeKind,
  type ShapeLayer,
  type TextLayer,
  defaultShadow,
  defaultStroke,
} from "@mycanvas/shared";

import { STARTER_THUMBNAILS } from "./starter-thumbnails";

// Built-in templates. Only text (Google fonts), shapes and empty frames, so
// they need no assets. Thumbnails are baked previews of the rendered designs.

const STAMP = "2026-10-22T00:00:00.000Z";

const base = {
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
  visible: true,
};

type TextOptions = Partial<Omit<TextLayer, "id" | "type" | "text">> & { x: number; y: number };

function text(id: string, value: string, options: TextOptions): TextLayer {
  return {
    ...base,
    id,
    type: "text",
    name: value.split("\n")[0] ?? "Text",
    text: value,
    fontFamily: "Inter",
    fontSize: 64,
    fontStyle: "normal",
    fill: "#ffffff",
    align: "left",
    lineHeight: 1.2,
    letterSpacing: 0,
    wrapWidth: 0,
    curve: 0,
    effect: { type: "none" },
    shadow: defaultShadow(),
    stroke: defaultStroke(),
    ...options,
  };
}

function rect(id: string, name: string, box: [number, number, number, number], fill: string, extra: Partial<RectLayer> = {}): RectLayer {
  const [x, y, width, height] = box;
  return {
    ...base,
    id,
    type: "rect",
    name,
    x,
    y,
    width,
    height,
    fill,
    cornerRadius: 0,
    stroke: defaultStroke(),
    shadow: defaultShadow(),
    ...extra,
  };
}

function shape(id: string, kind: ShapeKind, box: [number, number, number, number], fill: string, extra: Partial<ShapeLayer> = {}): ShapeLayer {
  const [x, y, width, height] = box;
  return {
    ...base,
    id,
    type: "shape",
    shape: kind,
    name: kind[0]?.toUpperCase() + kind.slice(1),
    x,
    y,
    width,
    height,
    fill,
    stroke: defaultStroke(),
    shadow: defaultShadow(),
    ...extra,
  };
}

function line(id: string, x: number, y: number, length: number, color: string, width: number): LineLayer {
  return {
    ...base,
    id,
    type: "line",
    name: "Line",
    x,
    y,
    points: [0, 0, length, 0],
    strokeColor: color,
    strokeWidth: width,
    lineCap: "round",
    shadow: defaultShadow(),
  };
}

function frame(id: string, kind: FrameShape, box: [number, number, number, number], cornerRadius = 0): FrameLayer {
  const [x, y, width, height] = box;
  return {
    ...base,
    id,
    type: "frame",
    shape: kind,
    name: "Photo frame",
    x,
    y,
    width,
    height,
    cornerRadius,
  };
}

function template(id: string, name: string, width: number, height: number, background: string, layers: Layer[]): Design {
  return {
    id,
    name,
    width,
    height,
    background,
    layers,
    thumbnail: STARTER_THUMBNAILS[id],
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

export const STARTER_TEMPLATES: Design[] = [
  template("starter-youtube", "Bold YouTube thumbnail", 1280, 720, "#111827", [
    shape("yt-sun", "circle", [740, 20, 600, 600], "#facc15"),
    frame("yt-photo", "circle", [790, 70, 500, 500]),
    rect("yt-tag", "Tag", [64, 72, 260, 64], "#ef4444", { cornerRadius: 12 }),
    text("yt-tag-text", "NEW VIDEO", {
      x: 64, y: 81, wrapWidth: 260, align: "center", fontFamily: "Bebas Neue", fontSize: 48, letterSpacing: 2,
    }),
    text("yt-head-1", "STOP DOING", { x: 60, y: 170, fontFamily: "Anton", fontSize: 112, lineHeight: 1 }),
    text("yt-head-2", "THIS!", {
      x: 54, y: 280, fontFamily: "Anton", fontSize: 236, lineHeight: 1, fill: "#facc15",
      effect: { type: "shadow", color: "#000000", distance: 10, angle: 45, blur: 0, opacity: 0.85 },
    }),
    text("yt-sub", "3 mistakes everyone makes", {
      x: 64, y: 560, fontFamily: "Montserrat", fontStyle: "bold", fontSize: 42, fill: "#e5e7eb",
    }),
    line("yt-rule", 66, 636, 220, "#facc15", 10),
  ]),
  template("starter-quote", "Quote card", 1080, 1080, "#f5efe6", [
    shape("q-blob", "circle", [700, 700, 520, 520], "#e07a5f", { opacity: 0.18 }),
    shape("q-dot", "circle", [880, 110, 90, 90], "#3d405b"),
    text("q-mark", "\u201C", { name: "Quote mark", x: 88, y: 40, fontFamily: "Playfair Display", fontSize: 360, fill: "#e07a5f", lineHeight: 1 }),
    text("q-body", "Simplicity is the ultimate sophistication.", {
      x: 100, y: 390, wrapWidth: 860, fontFamily: "Playfair Display", fontStyle: "italic", fontSize: 76,
      lineHeight: 1.2, fill: "#1f2937",
    }),
    line("q-rule", 104, 720, 120, "#e07a5f", 8),
    text("q-author", "LEONARDO DA VINCI", {
      x: 100, y: 755, fontFamily: "Montserrat", fontStyle: "bold", fontSize: 34, letterSpacing: 6, fill: "#3d405b",
    }),
  ]),
  template("starter-story", "Launch story", 1080, 1920, "#1e1b4b", [
    shape("st-glow-1", "circle", [-260, -240, 960, 960], "#7c3aed", { opacity: 0.6 }),
    shape("st-glow-2", "circle", [460, 1340, 900, 900], "#ec4899", { opacity: 0.5 }),
    shape("st-star", "star", [810, 250, 150, 150], "#facc15", { rotation: 12 }),
    text("st-kicker", "COMING FRIDAY", {
      x: 60, y: 380, wrapWidth: 960, align: "center", fontFamily: "Montserrat", fontStyle: "bold",
      fontSize: 44, letterSpacing: 10, fill: "#f9a8d4",
    }),
    text("st-head", "BIG NEWS", {
      x: 60, y: 450, wrapWidth: 960, align: "center", fontFamily: "Bebas Neue", fontSize: 260, lineHeight: 1,
      effect: { type: "shadow", color: "#000000", distance: 12, angle: 60, blur: 24, opacity: 0.45 },
    }),
    frame("st-photo", "rect", [140, 760, 800, 620], 40),
    text("st-body", "We're launching something new.\nYou'll want to be first.", {
      x: 90, y: 1440, wrapWidth: 900, align: "center", fontFamily: "Poppins", fontSize: 52, lineHeight: 1.3,
    }),
    rect("st-button", "Button", [290, 1640, 500, 124], "#facc15", { cornerRadius: 62 }),
    text("st-cta", "SWIPE UP", {
      x: 290, y: 1677, wrapWidth: 500, align: "center", fontFamily: "Montserrat", fontStyle: "bold",
      fontSize: 50, letterSpacing: 6, fill: "#1e1b4b",
    }),
  ]),
  template("starter-header", "X / Twitter header", 1500, 500, "#0b1220", [
    shape("h-hex-1", "hexagon", [1230, 50, 190, 167], "#22d3ee"),
    shape("h-hex-2", "hexagon", [1330, 230, 140, 123], "#6366f1"),
    shape("h-hex-3", "hexagon", [1215, 265, 96, 84], "#f472b6", { opacity: 0.85 }),
    text("h-name", "Jane Doe", { x: 470, y: 130, fontFamily: "Space Grotesk", fontStyle: "bold", fontSize: 104 }),
    line("h-rule", 476, 270, 150, "#22d3ee", 8),
    text("h-tagline", "Designer \u00B7 Builder \u00B7 Coffee enthusiast", {
      x: 474, y: 300, fontFamily: "Inter", fontSize: 38, fill: "#94a3b8",
    }),
  ]),
];

export function findStarterTemplate(id: string): Design | undefined {
  return STARTER_TEMPLATES.find((entry) => entry.id === id);
}
