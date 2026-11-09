import Konva from "konva";
import {
  type BlockItem,
  type BlockSlots,
  type BlockTheme,
  type FrameLayer,
  type Layer,
  type LineLayer,
  type RectLayer,
  type ShapeLayer,
  type TextLayer,
  type VisualPart,
  defaultShadow,
  defaultStroke,
} from "@mycanvas/shared";
import { coverContent } from "../frames";
import { mix } from "./themes";

/*
 * Draws one visual block as ordinary layers. Everything comes from the
 * theme (fonts, colours, radius) and the page size; text that runs long
 * makes the whole block shrink a step at a time until it fits.
 */

export interface RenderInput {
  part: VisualPart;
  theme: BlockTheme;
  width: number;
  height: number;
  pageNumber: number;
  pageCount: number;
  /** Natural sizes of the pictures used, by asset name. */
  imageSizes: Map<string, { width: number; height: number }>;
}

export interface RenderedPage {
  background: string;
  layers: Layer[];
  /** True when even the smallest step didn't fit. */
  overflow: boolean;
}

type Role = "display" | "statement" | "title" | "label" | "lead" | "body" | "small" | "kicker" | "value" | "number" | "mark";

interface Palette {
  background: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  card: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Layers laid out from y = 0 down, and how tall they are. */
interface Stack {
  layers: Layer[];
  height: number;
}

const ROLE_SIZE: Record<Role, number> = {
  display: 104,
  statement: 76,
  title: 66,
  label: 42,
  lead: 40,
  body: 36,
  small: 28,
  kicker: 26,
  value: 120,
  number: 150,
  mark: 220,
};

const ROLE_LINE: Record<Role, number> = {
  display: 1.04,
  statement: 1.14,
  title: 1.1,
  label: 1.2,
  lead: 1.35,
  body: 1.4,
  small: 1.35,
  kicker: 1.2,
  value: 1,
  number: 1,
  mark: 1,
};

const HEADING_ROLES = new Set<Role>(["display", "statement", "title", "label", "value", "number", "mark"]);

const id = () => crypto.randomUUID();

const base = (name: string, x: number, y: number) => ({ id: id(), name, x, y, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true });

function paletteFor(theme: BlockTheme, accent: VisualPart["variant"]["accent"]): Palette {
  const c = theme.colors;
  if (accent === "bold") {
    return { background: c.primary, text: c.onPrimary, muted: mix(c.onPrimary, c.primary, 0.28), accent: c.onPrimary, onAccent: c.primary, card: mix(c.primary, c.onPrimary, 0.12) };
  }
  if (accent === "tint") {
    return { background: c.surface, text: c.text, muted: c.muted, accent: c.primary, onAccent: c.onPrimary, card: c.background };
  }
  return { background: c.background, text: c.text, muted: c.muted, accent: c.primary, onAccent: c.onPrimary, card: c.surface };
}

class Painter {
  readonly u: number;
  constructor(
    readonly theme: BlockTheme,
    readonly palette: Palette,
    readonly scale: number,
    unit: number,
  ) {
    this.u = unit;
  }

  font(role: Role) {
    const font = HEADING_ROLES.has(role) ? this.theme.fonts.heading : this.theme.fonts.body;
    return {
      family: font.family,
      style: role === "kicker" ? "bold" : role === "lead" || role === "body" || role === "small" ? this.theme.fonts.body.style : font.style,
      size: Math.round(ROLE_SIZE[role] * this.u * this.scale * 10) / 10,
      lineHeight: ROLE_LINE[role],
      letterSpacing: role === "kicker" ? Math.round(3 * this.u * 10) / 10 : 0,
    };
  }

  /** A wrapped text layer and its measured height. */
  text(name: string, slot: string | undefined, value: string, role: Role, x: number, y: number, width: number, align: TextLayer["align"], fill: string, sizeFactor = 1): { layer: TextLayer; height: number } {
    const font = this.font(role);
    const shown = role === "kicker" ? value.toUpperCase() : value;
    // Words never break in the middle: a word wider than the column shrinks the text.
    const longest = shown.split(/\s+/).reduce((widest, word) => (word.length > widest.length ? word : widest), "");
    const wordWidth = longest ? new Konva.Text({ text: longest, fontFamily: font.family, fontStyle: font.style, fontSize: font.size * sizeFactor, letterSpacing: font.letterSpacing }).width() : 0;
    const fitWord = wordWidth > width * 0.98 ? (width * 0.98) / wordWidth : 1;
    const fontSize = Math.round(font.size * sizeFactor * fitWord * 10) / 10;
    const node = new Konva.Text({ text: shown, fontFamily: font.family, fontStyle: font.style, fontSize, lineHeight: font.lineHeight, letterSpacing: font.letterSpacing, width: Math.max(1, width), align });
    const layer: TextLayer = {
      ...base(name, x, y),
      type: "text",
      text: shown,
      fontFamily: font.family,
      fontSize,
      fontStyle: font.style,
      fill,
      align,
      lineHeight: font.lineHeight,
      letterSpacing: font.letterSpacing,
      wrapWidth: Math.round(width),
      effect: { type: "none" },
      shadow: defaultShadow(),
      stroke: defaultStroke(),
      ...(slot ? { blockSlot: slot } : {}),
    };
    return { layer, height: node.height() };
  }

  /** Width of one line of text (for pills and markers). */
  lineWidth(value: string, role: Role, sizeFactor = 1): number {
    const font = this.font(role);
    return new Konva.Text({ text: value, fontFamily: font.family, fontStyle: font.style, fontSize: font.size * sizeFactor, letterSpacing: font.letterSpacing }).width();
  }

  rect(name: string, box: Box, fill: string, radius = this.theme.radius * this.u): RectLayer {
    return { ...base(name, box.x, box.y), type: "rect", width: box.width, height: box.height, fill, cornerRadius: Math.min(radius, box.height / 2, box.width / 2), stroke: defaultStroke(), shadow: defaultShadow() };
  }

  circle(name: string, x: number, y: number, size: number, fill: string): ShapeLayer {
    return { ...base(name, x, y), type: "shape", shape: "circle", width: size, height: size, fill, stroke: defaultStroke(), shadow: defaultShadow() };
  }

  line(name: string, x1: number, y1: number, x2: number, y2: number, color: string, width: number): LineLayer {
    return { ...base(name, 0, 0), type: "line", points: [x1, y1, x2, y2], strokeColor: color, strokeWidth: width, lineCap: "round", shadow: defaultShadow() };
  }
}

/** Moves every layer of a stack down by dy (lines carry their own points). */
function shift(layers: Layer[], dx: number, dy: number): Layer[] {
  return layers.map((layer) => {
    if (layer.type === "line") {
      const [x1, y1, x2, y2] = layer.points;
      return { ...layer, points: [x1 + dx, y1 + dy, x2 + dx, y2 + dy] };
    }
    return { ...layer, x: layer.x + dx, y: layer.y + dy };
  });
}

/** Simple vertical flow: texts and gaps. */
class Flow {
  layers: Layer[] = [];
  y = 0;
  private pendingGap = 0;
  constructor(readonly painter: Painter, readonly x: number, readonly width: number, readonly align: TextLayer["align"]) {}

  gap(px: number) {
    if (this.layers.length > 0) {
      this.pendingGap = Math.max(this.pendingGap, px * this.painter.u * this.painter.scale);
    }
  }

  text(name: string, slot: string, value: string | undefined, role: Role, fill: string, sizeFactor = 1) {
    if (!value) {
      return;
    }
    this.y += this.pendingGap;
    this.pendingGap = 0;
    const { layer, height } = this.painter.text(name, slot, value, role, this.x, this.y, this.width, this.align, fill, sizeFactor);
    this.layers.push(layer);
    this.y += height;
  }

  /** A short accent bar, placed by alignment. */
  bar(color: string, width = 80, height = 10) {
    const u = this.painter.u;
    this.y += this.pendingGap;
    this.pendingGap = 0;
    const w = width * u;
    const x = this.align === "left" ? this.x : this.align === "right" ? this.x + this.width - w : this.x + (this.width - w) / 2;
    this.layers.push(this.painter.rect("Accent bar", { x, y: this.y, width: w, height: height * u }, color, height * u / 2));
    this.y += height * u;
  }

  add(stack: Stack) {
    this.y += this.pendingGap;
    this.pendingGap = 0;
    this.layers.push(...shift(stack.layers, 0, this.y));
    this.y += stack.height;
  }

  stack(): Stack {
    return { layers: this.layers, height: this.y };
  }
}

/** One list entry with a marker (dot or number) on the aligned side. */
function markedItem(painter: Painter, palette: Palette, item: BlockItem, index: number, width: number, align: TextLayer["align"], marker: "dot" | "number"): Stack {
  const u = painter.u * painter.scale;
  const markerSize = marker === "number" ? 64 * u : 16 * u;
  const gap = marker === "number" ? 28 * u : 26 * u;
  const layers: Layer[] = [];
  const textWidth = align === "center" ? width : width - markerSize - gap;
  const textX = align === "left" ? markerSize + gap : 0;
  const flow = new Flow(painter, textX, textWidth, align);
  if (align === "center") {
    flow.y = markerSize + 18 * u;
  }
  flow.text("Item label", `items.${String(index)}.label`, item.label, "label", palette.text);
  flow.gap(8);
  flow.text("Item text", `items.${String(index)}.text`, item.text, marker === "number" || item.label ? "body" : "lead", item.label ? palette.muted : palette.text, item.label ? 1 : 0.85);
  const stack = flow.stack();
  const font = painter.font(item.label ? "label" : "lead");
  // The marker sits on the first line's middle.
  const firstLine = (item.label ? font.size * font.lineHeight : font.size * 0.85 * font.lineHeight);
  const markerX = align === "left" ? 0 : align === "right" ? width - markerSize : (width - markerSize) / 2;
  const markerY = align === "center" ? 0 : Math.max(0, firstLine / 2 - markerSize / 2);
  if (marker === "number") {
    layers.push(painter.circle("Step number", markerX, markerY, markerSize, palette.accent));
    const label = painter.text("Step number text", undefined, String(index + 1), "label", markerX, 0, markerSize, "center", palette.onAccent, 0.8);
    label.layer.y = markerY + (markerSize - label.height) / 2;
    layers.push(label.layer);
  } else {
    layers.push(painter.circle("Bullet", markerX, markerY, markerSize, palette.accent));
  }
  layers.push(...stack.layers);
  return { layers, height: Math.max(stack.height, markerY + markerSize) };
}

/** Cards in columns: equal heights per row. */
function cardGrid(painter: Painter, cells: ((width: number) => Stack)[], width: number, columns: number, fill: string): Stack {
  const u = painter.u * painter.scale;
  const gap = 28 * u;
  const pad = 36 * u;
  const layers: Layer[] = [];
  let y = 0;
  for (let start = 0; start < cells.length; start += columns) {
    const row = cells.slice(start, start + columns);
    // A last row with fewer cards spreads them across the full width.
    const cellWidth = (width - gap * (row.length - 1)) / row.length;
    const stacks = row.map((cell) => cell(cellWidth - pad * 2));
    const height = Math.max(...stacks.map((stack) => stack.height)) + pad * 2;
    stacks.forEach((stack, index) => {
      const x = index * (cellWidth + gap);
      layers.push(painter.rect("Card", { x, y, width: cellWidth, height }, fill));
      layers.push(...shift(stack.layers, x + pad, y + pad));
    });
    y += height + gap;
  }
  return { layers, height: Math.max(0, y - gap) };
}

function layoutItems(painter: Painter, palette: Palette, part: VisualPart, width: number): Stack {
  const u = painter.u * painter.scale;
  const items = part.slots.items ?? [];
  const align = part.variant.align;
  const arrange = part.variant.arrange ?? "list";
  const block = part.block;

  if (block === "points" || (block === "steps" && arrange === "list")) {
    const flow = new Flow(painter, 0, width, align);
    items.forEach((item, index) => {
      flow.gap(block === "steps" ? 40 : 34);
      flow.add(markedItem(painter, palette, item, index, width, align, block === "steps" ? "number" : "dot"));
    });
    return flow.stack();
  }

  if (block === "steps" || block === "cards") {
    const columns = arrange === "row" ? items.length : arrange === "grid" ? 2 : 1;
    const cells = items.map((item, index) => (cellWidth: number) => {
      const flow = new Flow(painter, 0, cellWidth, align);
      if (block === "steps") {
        flow.text("Step number", "", String(index + 1).padStart(2, "0"), "label", palette.accent, 1.1);
        flow.gap(14);
      }
      flow.text("Card label", `items.${String(index)}.label`, item.label, "label", palette.text, columns > 2 ? 0.8 : 0.9);
      flow.gap(12);
      flow.text("Card text", `items.${String(index)}.text`, item.text, "body", palette.muted, columns > 2 ? 0.85 : 0.95);
      return flow.stack();
    });
    return cardGrid(painter, cells, width, columns, palette.card);
  }

  if (block === "stats") {
    if (arrange === "row" && items.length > 1) {
      const gap = 36 * u;
      const cellWidth = (width - gap * (items.length - 1)) / items.length;
      const layers: Layer[] = [];
      let height = 0;
      items.forEach((item, index) => {
        const flow = new Flow(painter, index * (cellWidth + gap), cellWidth, align);
        flow.text("Value", `items.${String(index)}.value`, item.value, "value", palette.accent, items.length > 2 ? 0.62 : 0.8);
        flow.gap(14);
        flow.text("Value label", `items.${String(index)}.label`, item.label, "body", palette.text);
        layers.push(...flow.layers);
        height = Math.max(height, flow.y);
      });
      return { layers, height };
    }
    const flow = new Flow(painter, 0, width, align);
    items.forEach((item, index) => {
      if (index > 0) {
        flow.gap(40);
        flow.bar(palette.muted, 120, 3);
      }
      flow.gap(40);
      flow.text("Value", `items.${String(index)}.value`, item.value, "value", palette.accent, items.length > 2 ? 0.8 : 1);
      flow.gap(10);
      flow.text("Value label", `items.${String(index)}.label`, item.label, "lead", palette.text, 0.9);
    });
    return flow.stack();
  }

  // Timeline.
  if (arrange === "row" && items.length > 1) {
    const gap = 28 * u;
    const cellWidth = (width - gap * (items.length - 1)) / items.length;
    const dot = 26 * u;
    const layers: Layer[] = [painter.line("Timeline", dot / 2, dot / 2, width - dot / 2, dot / 2, palette.muted, 3 * u)];
    let height = dot;
    items.forEach((item, index) => {
      const x = index * (cellWidth + gap);
      layers.push(painter.circle("Timeline dot", x, 0, dot, palette.accent));
      const flow = new Flow(painter, x, cellWidth, "left");
      flow.y = dot + 28 * u;
      flow.text("When", `items.${String(index)}.when`, item.when, "kicker", palette.accent);
      flow.gap(10);
      flow.text("Event", `items.${String(index)}.label`, item.label, "label", palette.text, 0.75);
      flow.gap(8);
      flow.text("Event text", `items.${String(index)}.text`, item.text, "body", palette.muted, 0.8);
      layers.push(...flow.layers);
      height = Math.max(height, flow.y);
    });
    return { layers, height };
  }
  const dot = 26 * u;
  const indent = dot + 36 * u;
  const flow = new Flow(painter, indent, width - indent, "left");
  const dots: number[] = [];
  items.forEach((item, index) => {
    if (flow.layers.length > 0) {
      flow.y += 44 * u;
    }
    dots.push(flow.y);
    flow.text("When", `items.${String(index)}.when`, item.when, "kicker", palette.accent);
    flow.gap(8);
    flow.text("Event", `items.${String(index)}.label`, item.label, "label", palette.text, 0.85);
    flow.gap(6);
    flow.text("Event text", `items.${String(index)}.text`, item.text, "body", palette.muted, 0.9);
  });
  const kicker = painter.font("kicker");
  const centre = (top: number) => top + (kicker.size * kicker.lineHeight) / 2 - dot / 2;
  const layers: Layer[] = [];
  if (dots.length > 1) {
    layers.push(painter.line("Timeline", dot / 2, centre(dots[0] ?? 0) + dot / 2, dot / 2, centre(dots[dots.length - 1] ?? 0) + dot / 2, palette.muted, 3 * u));
  }
  dots.forEach((top) => { layers.push(painter.circle("Timeline dot", 0, centre(top), dot, palette.accent)); });
  return { layers: [...layers, ...flow.layers], height: flow.y };
}

function compareColumns(painter: Painter, palette: Palette, slots: BlockSlots, width: number, align: TextLayer["align"]): Stack {
  const u = painter.u * painter.scale;
  const sides = [slots.left, slots.right];
  const cells = sides.map((side, sideIndex) => (cellWidth: number) => {
    const key = sideIndex === 0 ? "left" : "right";
    const strong = sideIndex === 1;
    const flow = new Flow(painter, 0, cellWidth, align);
    flow.text("Side label", `${key}.label`, side?.label, "label", strong ? palette.onAccent : palette.accent, 0.8);
    flow.gap(18);
    flow.bar(strong ? palette.onAccent : palette.accent, 48, 4);
    (side?.items ?? []).forEach((item, index) => {
      flow.gap(index === 0 ? 24 : 18);
      flow.text("Side point", `${key}.items.${String(index)}`, item, "body", strong ? palette.onAccent : palette.text, 0.92);
    });
    return flow.stack();
  });
  const gap = 24 * u;
  const pad = 36 * u;
  const cellWidth = (width - gap) / 2;
  const stacks = cells.map((cell) => cell(cellWidth - pad * 2));
  const height = Math.max(...stacks.map((stack) => stack.height)) + pad * 2;
  const layers: Layer[] = [];
  stacks.forEach((stack, index) => {
    const x = index * (cellWidth + gap);
    layers.push(painter.rect(index === 0 ? "Left side" : "Right side", { x, y: 0, width: cellWidth, height }, index === 0 ? palette.card : palette.accent));
    layers.push(...shift(stack.layers, x + pad, pad));
  });
  return { layers, height };
}

/** The block's text content in a column of the given width. */
function content(painter: Painter, palette: Palette, part: VisualPart, width: number): Stack {
  const slots = part.slots;
  const align = part.variant.align;
  const flow = new Flow(painter, 0, width, align);
  switch (part.block) {
    case "cover":
      flow.bar(palette.accent);
      flow.gap(36);
      flow.text("Kicker", "kicker", slots.kicker, "kicker", palette.accent);
      flow.gap(22);
      flow.text("Title", "title", slots.title, "display", palette.text);
      flow.gap(30);
      flow.text("Subtitle", "subtitle", slots.subtitle, "lead", palette.muted);
      flow.gap(56);
      flow.text("Author", "author", slots.author, "small", palette.muted);
      break;
    case "statement":
      flow.text("Kicker", "kicker", slots.kicker, "kicker", palette.accent);
      flow.gap(30);
      flow.bar(palette.accent);
      flow.gap(40);
      flow.text("Statement", "text", slots.text, "statement", palette.text);
      break;
    case "section":
      flow.text("Number", "number", slots.number, "number", palette.accent);
      flow.gap(24);
      flow.bar(palette.accent, 120, 6);
      flow.gap(40);
      flow.text("Title", "title", slots.title, "display", palette.text, 0.9);
      flow.gap(26);
      flow.text("Subtitle", "subtitle", slots.subtitle, "lead", palette.muted);
      break;
    case "points":
    case "steps":
    case "cards":
    case "stats":
    case "timeline":
      flow.text("Title", "title", slots.title, "title", palette.text);
      flow.gap(56);
      flow.add(layoutItems(painter, palette, part, width));
      break;
    case "compare":
      flow.text("Title", "title", slots.title, "title", palette.text);
      flow.gap(56);
      flow.add(compareColumns(painter, palette, slots, width, align));
      break;
    case "quote":
      flow.text("Quote mark", "", "“", "mark", palette.accent);
      flow.y -= painter.font("mark").size * 0.45;
      flow.text("Quote", "text", slots.text, "statement", palette.text, 0.78);
      flow.gap(40);
      flow.text("Author", "author", slots.author, "label", palette.text, 0.8);
      flow.gap(6);
      flow.text("Role", "role", slots.role, "small", palette.muted);
      break;
    case "pictureText":
      flow.text("Title", "title", slots.title, "title", palette.text, 0.9);
      flow.gap(28);
      flow.text("Text", "text", slots.text, "lead", palette.muted, 0.9);
      break;
    case "closing": {
      flow.text("Title", "title", slots.title, "display", palette.text, 0.8);
      flow.gap(30);
      flow.text("Text", "text", slots.text, "lead", palette.muted);
      if (slots.action) {
        flow.gap(56);
        const u = painter.u * painter.scale;
        const padX = 44 * u;
        const label = painter.text("Action", "action", slots.action, "label", 0, 0, painter.lineWidth(slots.action, "label", 0.8) + 4, "center", palette.onAccent, 0.8);
        const pillWidth = Math.min(width, label.layer.wrapWidth + padX * 2);
        const pillHeight = label.height + 36 * u;
        const x = align === "left" ? 0 : align === "right" ? width - pillWidth : (width - pillWidth) / 2;
        label.layer.x = x + (pillWidth - label.layer.wrapWidth) / 2;
        label.layer.y = 18 * u;
        label.layer.wrapWidth = Math.round(label.layer.wrapWidth);
        flow.add({ layers: [painter.rect("Action button", { x, y: 0, width: pillWidth, height: pillHeight }, palette.accent, pillHeight / 2), label.layer], height: pillHeight });
      }
      flow.gap(36);
      flow.text("Handle", "handle", slots.handle, "small", palette.muted);
      break;
    }
  }
  return flow.stack();
}

function pictureFrame(input: RenderInput, box: Box, radius: number): FrameLayer {
  const asset = input.part.slots.image;
  const size = asset ? input.imageSizes.get(asset) : undefined;
  return {
    ...base(asset ? "Picture" : `Picture: ${input.part.slots.imageQuery ?? "drop an image here"}`, box.x, box.y),
    type: "frame",
    shape: "rect",
    width: box.width,
    height: box.height,
    cornerRadius: radius,
    ...(asset && size ? { content: coverContent(asset, size.width, size.height, box.width, box.height) } : {}),
    blockSlot: "image",
  };
}

/** Lays out the page at one text scale; returns the layers and whether they fit. */
function attempt(input: RenderInput, scale: number): { layers: Layer[]; fits: boolean; fill: number; palette: Palette } {
  const { part, theme, width: W, height: H } = input;
  const unit = Math.min(W, H) / 1080;
  const palette = paletteFor(theme, part.variant.accent);
  const painter = new Painter(theme, palette, scale, unit);
  const margin = 96 * unit;
  const footer = 70 * unit;
  let area: Box = { x: margin, y: margin, width: W - margin * 2, height: H - margin * 2 - footer };
  const layers: Layer[] = [];

  const spec = part.block;
  const wantsPicture = spec === "pictureText" || ((spec === "cover" || spec === "quote") && part.slots.image !== undefined);
  if (wantsPicture) {
    const side = part.variant.side ?? "top";
    if (side === "top") {
      const pictureHeight = Math.round(H * (spec === "cover" ? 0.5 : 0.46));
      layers.push(pictureFrame(input, { x: 0, y: 0, width: W, height: pictureHeight }, 0));
      area = { x: margin, y: pictureHeight + margin * 0.7, width: W - margin * 2, height: H - pictureHeight - margin * 1.7 - footer };
    } else {
      const pictureWidth = Math.round(W * 0.46);
      const pictureX = side === "left" ? 0 : W - pictureWidth;
      layers.push(pictureFrame(input, { x: pictureX, y: 0, width: pictureWidth, height: H }, 0));
      area = { x: side === "left" ? pictureWidth + margin * 0.7 : margin, y: margin, width: W - pictureWidth - margin * 1.7, height: H - margin * 2 - footer };
    }
  }

  const stack = content(painter, palette, part, area.width);
  // Short content sits a little above the middle; list pages start nearer the top.
  const listy = ["points", "steps", "cards", "stats", "timeline", "compare"].includes(spec);
  const free = area.height - stack.height;
  const offset = free > 0 ? free * (listy ? 0.4 : wantsPicture && (part.variant.side ?? "top") === "top" ? 0.2 : 0.5) : 0;
  layers.push(...shift(stack.layers, area.x, area.y + offset));

  // Page counter, out of the way of the content's alignment.
  if (input.pageCount > 1) {
    const label = `${String(input.pageNumber).padStart(2, "0")} / ${String(input.pageCount).padStart(2, "0")}`;
    const counter = painter.text("Page number", undefined, label, "small", margin, H - margin * 0.6 - footer * 0.5, W - margin * 2, part.variant.align === "right" ? "left" : "right", palette.muted, 0.85 / scale);
    layers.push(counter.layer);
  }
  return { layers, fits: stack.height <= area.height + 1, fill: stack.height / Math.max(1, area.height), palette };
}

/** How far a block may grow past its base sizes when the page has room. */
const MAX_GROW: Record<VisualPart["block"], number> = {
  cover: 1.15,
  statement: 1.2,
  section: 1.15,
  points: 1.45,
  steps: 1.45,
  cards: 1.45,
  stats: 1.3,
  compare: 1.15,
  quote: 1.2,
  pictureText: 1.3,
  timeline: 1.4,
  closing: 1.15,
};

/** Share of the page height growing content may take (the rest stays air). */
const GROW_FILL = 0.82;

/**
 * Picks the text scale: grows short content (up to the block's limit) while
 * it fills less than GROW_FILL of the page, and shrinks long content a step
 * at a time until it fits.
 */
export function renderPart(input: RenderInput): RenderedPage {
  let scale = 1;
  let result = attempt(input, scale);
  if (result.fits) {
    const max = MAX_GROW[input.part.block];
    while (scale < max) {
      const next = Math.min(max, Math.round((scale + 0.05) * 1000) / 1000);
      const bigger = attempt(input, next);
      if (!bigger.fits || bigger.fill > GROW_FILL) {
        break;
      }
      scale = next;
      result = bigger;
    }
  }
  while (!result.fits && scale > 0.5) {
    scale = Math.round(scale * 0.92 * 1000) / 1000;
    result = attempt(input, scale);
  }
  return { background: result.palette.background, layers: result.layers, overflow: !result.fits };
}

function setPath(slots: BlockSlots, path: string, value: string) {
  const [head, second, third] = path.split(".");
  if (!head) {
    return;
  }
  if (head === "items" && second !== undefined && third) {
    const index = Number(second);
    const items = slots.items ?? [];
    const item = items[index];
    if (item && (third === "label" || third === "text" || third === "value" || third === "when")) {
      items[index] = { ...item, [third]: value };
      slots.items = items;
    }
    return;
  }
  if ((head === "left" || head === "right") && second) {
    const side = slots[head] ?? { label: "", items: [] };
    if (second === "label") {
      slots[head] = { ...side, label: value };
    } else if (second === "items" && third !== undefined) {
      const items = [...side.items];
      items[Number(third)] = value;
      slots[head] = { ...side, items };
    }
    return;
  }
  const textSlots = ["kicker", "title", "subtitle", "text", "number", "author", "role", "action", "handle"] as const;
  const key = textSlots.find((slot) => slot === head);
  if (key) {
    slots[key] = value;
  }
}

/**
 * The part's slots updated from the page's layers: text edited on the canvas
 * and a picture dropped into the frame are kept when the page is redrawn.
 */
export function readSlots(part: VisualPart, layers: Layer[]): BlockSlots {
  const slots: BlockSlots = structuredClone(part.slots);
  for (const layer of layers) {
    if (!layer.blockSlot) {
      continue;
    }
    if (layer.type === "text") {
      // Kickers are drawn in capitals: keep the original when only the case differs.
      const original = layer.blockSlot === "kicker" ? part.slots.kicker : undefined;
      const value = original?.toUpperCase() === layer.text ? original : layer.text;
      setPath(slots, layer.blockSlot, value);
    } else if (layer.type === "frame" && layer.blockSlot === "image") {
      if (layer.content?.asset) {
        slots.image = layer.content.asset;
      }
    }
  }
  return slots;
}
