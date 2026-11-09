import Konva from "konva";
import {
  type DesignPage,
  type ImageLayer,
  type Layer,
  type RectLayer,
  type TextLayer,
  defaultShadow,
  defaultStroke,
  formatFontStyle,
  parseFontStyle,
} from "@mycanvas/shared";
import { api } from "../../api";
import { newLayerId, syncedPages, useEditorStore } from "../../store/editorStore";
import { aiText } from "../ai-client";
import { TEXT_MAIN_NAME } from "../behind-text";
import { getContentLayer, getLayerNode } from "../canvas-bridge";
import { ensureFontsLoaded } from "../fonts";
import { waitForPage } from "../pdf-export";
import { type Change, type ReviewEdit, type TableRow, type TextBlockKind, applyChanges, describeRows, parseEdits } from "./edits";
import {
  type Pixels,
  type Rect,
  type Rgb,
  colorAround,
  colorDistance,
  colorNear,
  difference,
  fromHex,
  inkColorDifference,
  inkMask,
  overlap,
  growBox,
  inkColors,
  pageColor,
  sameBlockInk,
  toHex,
} from "./measure";

/*
 * AI review of a format against the example it was made from. A vision model
 * compares the two pages and suggests edits from a fixed list (see edits.ts).
 * Each edit is then checked here: colours and box edges are measured in the
 * example, positions and sizes are fine-tuned, and every change that can be
 * compared is rendered and kept only if the page gets closer to the example.
 */

export type Verdict = "closer" | "measured" | "judgment" | "dropped";

export interface Suggestion {
  id: string;
  pageId: string;
  pageNumber: number;
  title: string;
  why: string;
  verdict: Verdict;
  /** What the check found, in words. */
  note: string;
  change: Change;
  /** Areas (design px) to paint out of the page's background art when applied. */
  paintOut: Rect[];
}

export interface ReviewResult {
  suggestions: Suggestion[];
  notes: string[];
  /** The model's raw answers, per page (for troubleshooting). */
  answers: string[];
}

/** Width of the low-resolution renders that are compared. */
const COMPARE_WIDTH = 400;

const LABELS: Record<TextBlockKind, string> = { title: "Title", lead: "Lead", heading: "Heading", body: "Body text", callout: "Callout" };

function pixelsOf(canvas: HTMLCanvasElement): Pixels {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas unavailable");
  }
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data: image.data, width: image.width, height: image.height };
}

function drawTo(source: CanvasImageSource, width: number, height: number, background = "#ffffff"): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
  }
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { resolve(image); };
    image.onerror = () => { reject(new Error("Couldn't load the example page image")); };
    image.src = url;
  });
}

function jpegDataUrl(canvas: HTMLCanvasElement, maxSide = 1024): string {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  return drawTo(canvas, Math.round(canvas.width * scale), Math.round(canvas.height * scale)).toDataURL("image/jpeg", 0.85);
}

/** The current render, faded, with the places that differ from the example in red. */
function differenceImage(current: Pixels, example: Pixels): string {
  const canvas = document.createElement("canvas");
  canvas.width = current.width;
  canvas.height = current.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }
  const out = context.createImageData(current.width, current.height);
  for (let index = 0; index < out.data.length; index += 4) {
    const diff = (Math.abs((current.data[index] ?? 0) - (example.data[index] ?? 0)) +
      Math.abs((current.data[index + 1] ?? 0) - (example.data[index + 1] ?? 0)) +
      Math.abs((current.data[index + 2] ?? 0) - (example.data[index + 2] ?? 0))) / 765;
    if (diff > 0.12) {
      out.data.set([230, 30, 30, 255], index);
    } else {
      const grey = ((current.data[index] ?? 0) + (current.data[index + 1] ?? 0) + (current.data[index + 2] ?? 0)) / 3;
      const faded = 200 + grey * 0.2;
      out.data.set([faded, faded, faded, 255], index);
    }
  }
  context.putImageData(out, 0, 0);
  return canvas.toDataURL("image/png");
}

function expand(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

const percent = (value: number) => `${String(Math.round(value * 100))}%`;

/** Smallest improvement (share of the area's difference) worth suggesting. */
const MIN_GAIN = 0.03;
const gain = (baseline: number, result: number) => (baseline - result) / Math.max(baseline, 1e-9);

/** Text must stand out from what's behind it (else hiding it would "match" misplaced text). */
const MIN_CONTRAST = 60;

/**
 * Colours of the letters in an area of the example: the most-used mark
 * colours, the ones furthest from the background first (anti-aliased edge
 * pixels sit between the two).
 */
function textInk(example: Pixels, rect: Rect, behind: Rgb): Rgb[] {
  const ink = inkColors(example, rect, behind, MIN_CONTRAST);
  const top = ink[0];
  if (!top) {
    return [];
  }
  const count = (color: Rgb) => ink.indexOf(color);
  return ink.slice(0, 6).sort((a, b) => colorDistance(b, behind) - colorDistance(a, behind) || count(a) - count(b)).slice(0, 2);
}

const SYSTEM = [
  "You review a document format: a page design made automatically from an example page. It should look like the example.",
  "Image 1 is the example. Image 2 is the format as made. Image 3 is the format faded, with the places that differ from the example in red.",
  "Positions, sizes and colours of texts are measured and fixed automatically. Focus on what needs understanding: what kind of block a text is, coloured boxes behind text, missing callouts, and text that should not repeat. Use only these edits (JSON objects):",
  "- {\"op\":\"style\",\"layer\":\"L3\",\"color\":\"#rrggbb\",\"size\":28,\"weight\":700}: a text's colour, size (px, like in the list) or weight (100-900). Give only what should change.",
  "- {\"op\":\"role\",\"layer\":\"L3\",\"block\":\"heading\"}: a sample text is the wrong kind of block (title, lead, heading, body, callout).",
  "- {\"op\":\"box\",\"layer\":\"L3\"}: in the example this sample text sits on a coloured box or strip, but the format has no box for it.",
  "- {\"op\":\"callout\",\"x\":500,\"y\":620,\"text\":\"...\"}: the example has text on a coloured box that the format lacks. x,y is a point inside the box (0-1000 grid); text is the text written on it.",
  "- {\"op\":\"remove\",\"layer\":\"L7\"}: fixed page text that is really the example's own content and should not repeat on every page.",
  "- {\"op\":\"flow\",\"top\":80,\"bottom\":900,\"left\":60,\"right\":940}: where the flow area should start and end (0-1000 grid). The flow area is where ALL new content goes, title included, so it starts at the title's top. Only change it when content would run into a footer, a logo or the page edge. Give only the edges that change.",
  "Each edit also needs \"why\": one short sentence. At most 8 edits; only clear problems. If the format already looks right, return no edits.",
  "Answer JSON only: {\"edits\": [...]}",
].join("\n");

interface PageContext {
  page: DesignPage;
  pageNumber: number;
  width: number;
  height: number;
  rows: TableRow[];
  example: Pixels;
  exampleCanvas: HTMLCanvasElement;
  exampleSmall: Pixels;
  /** Example crops by area, for scoring. */
  crops: Map<string, Pixels>;
  contentLayer: Konva.Layer;
  /** Every layer of every page (for "does the format already have…" checks). */
  allLayers: Layer[];
}

function renderSmall(context: PageContext): Pixels {
  const canvas = context.contentLayer.toCanvas({ x: 0, y: 0, width: context.width, height: context.height, pixelRatio: COMPARE_WIDTH / context.width });
  return pixelsOf(drawTo(canvas, context.exampleSmall.width, context.exampleSmall.height));
}

/** A design-px area of an image, scaled to width × height. */
function crop(source: CanvasImageSource, area: Rect, width: number, height: number): Pixels {
  const canvas = drawTo(source, width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(source, area.x, area.y, area.width, area.height, 0, 0, width, height);
  }
  return pixelsOf(canvas);
}

interface Area {
  box: Rect;
  width: number;
  height: number;
  key: string;
}

/** A design-px area on the page, and the size it's compared at (up to full resolution). */
function areaOf(context: PageContext, area: Rect): Area {
  const x = Math.max(0, Math.floor(area.x));
  const y = Math.max(0, Math.floor(area.y));
  const box = { x, y, width: Math.max(1, Math.min(context.width, Math.ceil(area.x + area.width)) - x), height: Math.max(1, Math.min(context.height, Math.ceil(area.y + area.height)) - y) };
  const ratio = Math.min(1, 640 / Math.max(box.width, box.height));
  return {
    box,
    width: Math.max(1, Math.round(box.width * ratio)),
    height: Math.max(1, Math.round(box.height * ratio)),
    key: `${String(box.x)},${String(box.y)},${String(box.width)},${String(box.height)}`,
  };
}

function exampleArea(context: PageContext, area: Area): Pixels {
  let pixels = context.crops.get(area.key);
  if (!pixels) {
    pixels = crop(context.exampleCanvas, area.box, area.width, area.height);
    context.crops.set(area.key, pixels);
  }
  return pixels;
}

function renderArea(context: PageContext, area: Area): Pixels {
  const rendered = context.contentLayer.toCanvas({ ...area.box, pixelRatio: area.width / area.box.width });
  return pixelsOf(drawTo(rendered, area.width, area.height));
}

/**
 * Difference to the example inside a design-px area, rendered at (up to)
 * full resolution so small text counts as much as big shapes.
 */
function score(context: PageContext, rect: Rect): number {
  const area = areaOf(context, rect);
  return difference(renderArea(context, area), exampleArea(context, area));
}

/** Renders with a temporary change to the live canvas, then undoes it. */
function trial(context: PageContext, area: Rect, change: () => () => void): number {
  const undo = change();
  try {
    return score(context, area);
  } finally {
    undo();
  }
}

function textNodes(id: string): { group: Konva.Node; main: Konva.Text } | null {
  const group = getLayerNode(id);
  if (!group) {
    return null;
  }
  const main = group instanceof Konva.Text ? group : group instanceof Konva.Container ? group.findOne<Konva.Text>(`.${TEXT_MAIN_NAME}`) : undefined;
  return main ? { group, main } : null;
}

function dropped(base: Omit<Suggestion, "verdict" | "note" | "change" | "paintOut">, note: string): Suggestion {
  return { ...base, verdict: "dropped", note, change: { patches: [], add: [], remove: [] }, paintOut: [] };
}

/** Finds a coloured box around a seed area in the example; null when there is none. */
function measureBox(context: PageContext, seed: Rect, inside: Rgb): { rect: Rect; color: Rgb } | null {
  const page = pageColor(context.example);
  const contrast = colorDistance(inside, page);
  if (contrast < 4) {
    return null;
  }
  const rect = growBox(context.example, seed, inside, Math.max(3, Math.min(18, contrast / 2)));
  const area = rect.width * rect.height;
  if (rect.width < 30 || rect.height < 16 || area > context.width * context.height * 0.7) {
    return null;
  }
  return { rect, color: inside };
}

function boxLayer(name: string, rect: Rect, color: Rgb, block: TextBlockKind): RectLayer {
  return {
    id: newLayerId(),
    name,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    visible: true,
    type: "rect",
    fill: toHex(color),
    cornerRadius: 0,
    stroke: defaultStroke(),
    shadow: defaultShadow(),
    formatRole: { kind: "box", block },
  };
}

interface Fit {
  /** Overlap with the example's letters, 0–1 (Dice). */
  overlap: number;
  dx: number;
  dy: number;
  size?: number;
  fill?: string;
}

/** Smallest rise in letter overlap worth suggesting (0–1). */
const MIN_OVERLAP_GAIN = 0.08;
/** Overlap a text may give up to keep its original left or top edge. */
const KEEP_EDGE_TOLERANCE = 0.04;
/** Smallest drop in letter colour difference worth suggesting (0–1). */
const MIN_COLOR_GAIN = 0.04;

/**
 * Fits a text to the example without the AI. Scores how well its letters
 * overlap the example's (each found against the page rendered without this
 * text), so hiding or shrinking text never "wins". Tries nearby positions and
 * sizes (both orders, since a wrong size throws the position search off and
 * the other way round), then the example's own ink colours there.
 */
function autoFit(context: PageContext, row: TableRow, pageId: string): Suggestion | null {
  const layer = row.layer as TextLayer;
  const nodes = textNodes(layer.id);
  if (!nodes || row.box.width < 2 || row.box.height < 2) {
    return null;
  }
  const reach = Math.min(96, Math.max(32, row.box.height));
  const area = areaOf(context, expand(row.box, reach));
  const example = exampleArea(context, area);
  const start = { x: nodes.group.x(), y: nodes.group.y() };
  const original = { fill: nodes.main.fill(), fontSize: nodes.main.fontSize() };
  const current = layer.fontSize;

  nodes.group.visible(false);
  const without = renderArea(context, area);
  nodes.group.visible(true);
  // Only the example's block of text that ours sits on counts (not the paragraphs around it).
  const scale = area.width / area.box.width;
  const exampleInk = sameBlockInk(inkMask(example, without), inkMask(renderArea(context, area), without), area.width, area.height, Math.max(1, Math.round(layer.fontSize * 0.35 * scale)));
  const measure = () => {
    const render = renderArea(context, area);
    const ink = inkMask(render, without);
    return { render, ink, overlap: overlap(ink, exampleInk) };
  };
  const before = measure();
  if (before.overlap > 0.95) {
    return null;
  }

  const run = (sizeFirst: boolean): Fit => {
    const fit: Fit = { overlap: before.overlap, dx: 0, dy: 0 };
    const show = () => {
      nodes.group.position({ x: start.x + fit.dx, y: start.y + fit.dy });
      nodes.main.fontSize(fit.size ?? original.fontSize);
    };
    const attempt = (change: () => void): boolean => {
      change();
      const result = measure().overlap;
      return result > fit.overlap + 1e-6 ? ((fit.overlap = result), true) : false;
    };
    const tryAt = (dx: number, dy: number) => {
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) {
        return false;
      }
      const ok = attempt(() => { nodes.group.position({ x: start.x + dx, y: start.y + dy }); });
      if (ok) {
        fit.dx = dx;
        fit.dy = dy;
      }
      show();
      return ok;
    };
    const descend = (steps: number[]) => {
      for (const step of steps) {
        for (let improved = true; improved;) {
          improved = false;
          for (const [sx, sy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
            improved = tryAt(fit.dx + sx, fit.dy + sy) || improved;
          }
        }
      }
    };
    const position = () => {
      // A coarse grid first (text matches in bumps a line apart), then small steps.
      const coarse = Math.max(8, Math.round(reach / 4));
      const from = { dx: fit.dx, dy: fit.dy };
      for (let gy = -reach; gy <= reach; gy += coarse) {
        for (let gx = -reach; gx <= reach; gx += coarse) {
          tryAt(from.dx + gx, from.dy + gy);
        }
      }
      descend([8, 4, 2, 1]);
    };
    const sizes = (values: number[]) => {
      for (const value of values) {
        if (value <= 3 || value === Math.round(fit.size ?? current)) {
          continue;
        }
        if (attempt(() => { nodes.main.fontSize(value); })) {
          fit.size = value;
        }
        show();
      }
    };
    const rough = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3].map((factor) => Math.round(current * factor));

    show();
    if (sizeFirst) {
      sizes(rough);
      position();
    } else {
      position();
      sizes(rough);
      descend([4, 2, 1]);
    }
    sizes([-2, -1, 1, 2].map((step) => Math.round(fit.size ?? current) + step));
    descend([2, 1]);
    return fit;
  };

  let fit: Fit;
  let colorBefore = 1;
  let colorAfter = 1;
  try {
    fit = run(false);
    // The other order matters when size is involved, or when the fit is still poor
    // (a too-big text "fits" a little better shifted, instead of smaller).
    if (fit.size !== undefined || fit.overlap < 0.85) {
      const sizeFirst = run(true);
      fit = sizeFirst.overlap > fit.overlap ? sizeFirst : fit;
    }
    nodes.main.fontSize(fit.size ?? original.fontSize);
    // Keep the original edges (alignment with other elements) unless moving clearly helps.
    const options: [number, number][] = [[0, 0], [0, fit.dy], [fit.dx, 0]];
    for (const [dx, dy] of options) {
      if (dx === fit.dx && dy === fit.dy) {
        continue;
      }
      nodes.group.position({ x: start.x + dx, y: start.y + dy });
      const kept = measure().overlap;
      // Widths differ more often than heights (letter spacing, stand-in fonts), so a
      // sideways move must earn more.
      const tolerance = (dx !== fit.dx ? KEEP_EDGE_TOLERANCE * 2.5 : 0) + (dy !== fit.dy ? KEEP_EDGE_TOLERANCE : 0);
      if (kept >= fit.overlap - tolerance) {
        fit = { ...fit, dx, dy, overlap: kept };
        break;
      }
    }
    nodes.group.position({ x: start.x + fit.dx, y: start.y + fit.dy });

    // Colour, where the letters overlap: the example's own ink, never one that would hide the text.
    const placed = measure();
    colorBefore = inkColorDifference(placed.render, example, placed.ink, exampleInk);
    colorAfter = colorBefore;
    const behind = colorAround(context.example, row.box, 4);
    const own = fromHex(layer.fill);
    for (const ink of textInk(context.example, expand(row.box, 2), behind)) {
      // Small shifts are anti-aliasing, not a different colour.
      if (own && colorDistance(ink, own) < 24) {
        continue;
      }
      const hex = toHex(ink);
      nodes.main.fill(hex);
      const tried = measure();
      const result = inkColorDifference(tried.render, example, tried.ink, exampleInk);
      if (result < colorAfter - 1e-6) {
        colorAfter = result;
        fit.fill = hex;
      }
      nodes.main.fill(original.fill);
    }
  } finally {
    nodes.group.position(start);
    nodes.main.fill(original.fill);
    nodes.main.fontSize(original.fontSize);
  }

  const placedBetter = fit.overlap - before.overlap >= MIN_OVERLAP_GAIN;
  const colorBetter = fit.fill !== undefined && colorBefore - colorAfter >= MIN_COLOR_GAIN;
  // A nudge of a few pixels alone isn't worth a suggestion.
  const moved = placedBetter && Math.hypot(fit.dx, fit.dy) >= (fit.size ? 1 : 4);
  const resized = placedBetter && fit.size !== undefined;
  if (!moved && !resized && !colorBetter) {
    return null;
  }
  const patch: Partial<TextLayer> = {};
  const changed: string[] = [];
  const notes: string[] = [];
  if (moved) {
    patch.x = Math.round(layer.x + fit.dx);
    patch.y = Math.round(layer.y + fit.dy);
    changed.push(`move ${String(Math.round(fit.dx))}, ${String(Math.round(fit.dy))} px`);
  }
  if (resized && fit.size !== undefined) {
    patch.fontSize = fit.size;
    changed.push(`size ${String(Math.round(current))} → ${String(fit.size)}`);
  }
  if (moved || resized) {
    notes.push(`its letters now cover the example's ${percent(fit.overlap)} (was ${percent(before.overlap)})`);
  }
  if (colorBetter && fit.fill) {
    patch.fill = fit.fill;
    changed.push(`colour ${layer.fill} → ${fit.fill}`);
    notes.push(`colour measured in the example's letters`);
  }
  return {
    id: newLayerId(),
    pageId,
    pageNumber: context.pageNumber,
    title: `${layer.name}: ${changed.join(", ")}`,
    why: "",
    verdict: "closer",
    note: `Measured against the example: ${notes.join("; ")}.`,
    change: { patches: [{ id: layer.id, patch }], add: [], remove: [] },
    paintOut: [],
  };
}

async function resolveStyle(context: PageContext, edit: Extract<ReviewEdit, { op: "style" }>, row: TableRow, base: Omit<Suggestion, "verdict" | "note" | "change" | "paintOut">): Promise<Suggestion> {
  const layer = row.layer as TextLayer;
  const nodes = textNodes(layer.id);
  if (!nodes) {
    return dropped(base, "That text isn't on the canvas.");
  }
  const area = expand(row.box, 12);
  const baseline = score(context, area);
  let best = baseline;
  const patch: Partial<TextLayer> = {};
  const tryValue = <T>(apply: (value: T) => () => void, values: T[]): T | undefined => {
    let chosen: T | undefined;
    for (const value of values) {
      const result = trial(context, area, () => apply(value));
      if (result < best - 1e-6) {
        best = result;
        chosen = value;
      }
    }
    return chosen;
  };
  const changed: string[] = [];

  if (edit.color) {
    // The model's colour, and the closest colour actually used there in the example.
    const suggested = fromHex(edit.color);
    const behind = colorAround(context.example, row.box, 4);
    const ink = textInk(context.example, row.box, behind);
    const snapped = suggested ? [...ink].sort((a, b) => colorDistance(a, suggested) - colorDistance(b, suggested))[0] : ink[0];
    const candidates = [...new Set([
      ...(suggested && colorDistance(suggested, behind) >= MIN_CONTRAST ? [edit.color] : []),
      ...(snapped ? [toHex(snapped)] : []),
    ])].filter((hex) => hex !== layer.fill.toLowerCase());
    const color = tryValue((hex: string) => {
      const before = nodes.main.fill();
      nodes.main.fill(hex);
      return () => { nodes.main.fill(before); };
    }, candidates);
    if (color) {
      patch.fill = color;
      nodes.main.fill(color);
      changed.push(`colour ${layer.fill} → ${color}`);
    }
  }
  if (edit.size) {
    const target = Math.round(edit.size);
    const sizes = [target, target - 1, target + 1, target - 2, target + 2].filter((size) => size > 3 && size !== Math.round(layer.fontSize));
    const size = tryValue((value: number) => {
      const before = nodes.main.fontSize();
      nodes.main.fontSize(value);
      return () => { nodes.main.fontSize(before); };
    }, sizes);
    if (size) {
      patch.fontSize = size;
      nodes.main.fontSize(size);
      changed.push(`size ${String(Math.round(layer.fontSize))} → ${String(size)}`);
    }
  }
  if (edit.weight) {
    const { italic, weight: current } = parseFontStyle(layer.fontStyle);
    if (edit.weight !== current) {
      const style = formatFontStyle({ weight: edit.weight, italic });
      await ensureFontsLoaded([{ fontFamily: layer.fontFamily, fontStyle: style }]);
      const weighted = tryValue((value: string) => {
        const before = nodes.main.fontStyle();
        nodes.main.fontStyle(value);
        return () => { nodes.main.fontStyle(before); };
      }, [style]);
      if (weighted) {
        patch.fontStyle = weighted;
        changed.push(`weight ${String(current)} → ${String(edit.weight)}`);
      }
    }
  }
  // Put the live canvas back; the change is applied later, if accepted.
  nodes.main.fill(layer.fill);
  nodes.main.fontSize(layer.fontSize);
  nodes.main.fontStyle(layer.fontStyle);
  if (changed.length === 0) {
    return dropped(base, "Tried it: the page looked less like the example, so it was left out.");
  }
  if (gain(baseline, best) < MIN_GAIN) {
    return dropped(base, `Tried it: barely any difference (${percent(gain(baseline, best))}), not worth changing.`);
  }
  return {
    ...base,
    title: `${layer.name}: ${changed.join(", ")}`,
    verdict: "closer",
    note: `${percent(gain(baseline, best))} closer to the example in that area.`,
    change: { patches: [{ id: layer.id, patch }], add: [], remove: [] },
    paintOut: [],
  };
}

function resolveMove(context: PageContext, edit: Extract<ReviewEdit, { op: "move" }>, row: TableRow, base: Omit<Suggestion, "verdict" | "note" | "change" | "paintOut">): Suggestion {
  const node = getLayerNode(row.layer.id);
  if (!node) {
    return dropped(base, "That layer isn't on the canvas.");
  }
  const target = { x: (edit.x / 1000) * context.width, y: (edit.y / 1000) * context.height };
  const area = expand(union(row.box, { ...row.box, ...target }), 16);
  const start = { x: node.x(), y: node.y() };
  const at = (dx: number, dy: number) => trial(context, area, () => {
    node.position({ x: start.x + dx, y: start.y + dy });
    return () => { node.position(start); };
  });
  const baseline = score(context, area);
  // Start where the model pointed, then fine-tune by small steps.
  let dx = target.x - row.box.x;
  let dy = target.y - row.box.y;
  let best = at(dx, dy);
  for (const step of [16, 8, 4, 2, 1]) {
    for (let improved = true; improved;) {
      improved = false;
      for (const [sx, sy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
        const result = at(dx + sx, dy + sy);
        if (result < best - 1e-6) {
          best = result;
          dx += sx;
          dy += sy;
          improved = true;
        }
      }
    }
  }
  if (gain(baseline, best) < MIN_GAIN || Math.hypot(dx, dy) < 1) {
    return dropped(base, "Tried it: it already sits where the example has it.");
  }
  return {
    ...base,
    title: `${row.layer.name}: move ${String(Math.round(dx))}, ${String(Math.round(dy))} px`,
    verdict: "closer",
    note: `Fine-tuned against the example: ${percent(gain(baseline, best))} closer in that area.`,
    change: { patches: [{ id: row.layer.id, patch: { x: Math.round(row.layer.x + dx), y: Math.round(row.layer.y + dy) } }], add: [], remove: [] },
    paintOut: [],
  };
}

function resolveRole(context: PageContext, edit: Extract<ReviewEdit, { op: "role" }>, row: TableRow, base: Omit<Suggestion, "verdict" | "note" | "change" | "paintOut">): Suggestion {
  const role = row.layer.formatRole;
  if (role?.kind !== "sample" || role.block === "image") {
    return dropped(base, "Only sample texts have a block kind.");
  }
  const from = role.block;
  const to = edit.block;
  const patches: Change["patches"] = [];
  const rename = (layer: Layer, block: TextBlockKind, suffix: string) => (/(sample|box)$/i.test(layer.name) ? { name: `${LABELS[block]} ${suffix}` } : {});
  patches.push({ id: row.layer.id, patch: { formatRole: { ...role, block: to }, ...rename(row.layer, to, "sample") } });
  // Swap with a sample that already had that kind, and move the boxes along.
  for (const { layer } of context.rows) {
    const other = layer.formatRole;
    if (layer.id === row.layer.id || !other) {
      continue;
    }
    if (other.kind === "sample" && other.block === to) {
      patches.push({ id: layer.id, patch: { formatRole: { ...other, block: from }, ...rename(layer, from, "sample") } });
    } else if (other.kind === "box" && (other.block === from || other.block === to)) {
      const block = other.block === from ? to : from;
      patches.push({ id: layer.id, patch: { formatRole: { kind: "box", block }, ...rename(layer, block, "box") } });
    }
  }
  return {
    ...base,
    title: `${row.layer.name}: ${LABELS[from].toLowerCase()} → ${LABELS[to].toLowerCase()}`,
    verdict: "judgment",
    note: "A meaning change, so it can't be checked by comparing pictures. Your call.",
    change: { patches, add: [], remove: [] },
    paintOut: [],
  };
}

function resolveBox(context: PageContext, row: TableRow, base: Omit<Suggestion, "verdict" | "note" | "change" | "paintOut">): Suggestion {
  const role = row.layer.formatRole;
  if (role?.kind !== "sample" || role.block === "image") {
    return dropped(base, "Only sample texts can have a box.");
  }
  if (context.rows.some(({ layer }) => layer.formatRole?.kind === "box" && layer.formatRole.block === role.block)) {
    return dropped(base, `The ${LABELS[role.block].toLowerCase()} already has a box.`);
  }
  const found = measureBox(context, expand(row.box, 2), colorAround(context.example, row.box, 6));
  if (!found) {
    return dropped(base, "Measured the example: there's no coloured shape behind that text.");
  }
  return {
    ...base,
    title: `${row.layer.name}: add its box (${toHex(found.color)})`,
    verdict: "measured",
    note: `Measured in the example: ${String(Math.round(found.rect.width))} × ${String(Math.round(found.rect.height))} px. It's also painted out of the background art, so it doesn't repeat on every page.`,
    change: { patches: [], add: [{ layers: [boxLayer(`${LABELS[role.block]} box`, found.rect, found.color, role.block)], before: row.layer.id }], remove: [] },
    paintOut: [found.rect],
  };
}

function resolveCallout(context: PageContext, edit: Extract<ReviewEdit, { op: "callout" }>, base: Omit<Suggestion, "verdict" | "note" | "change" | "paintOut">): Suggestion {
  if (context.allLayers.some((layer) => layer.formatRole?.kind === "sample" && layer.formatRole.block === "callout")) {
    return dropped(base, "The format already has a callout sample. If a different text is the callout, change its kind instead.");
  }
  const point = { x: (edit.x / 1000) * context.width, y: (edit.y / 1000) * context.height };
  const inside = colorNear(context.example, point.x, point.y);
  const found = measureBox(context, { x: point.x - 2, y: point.y - 2, width: 4, height: 4 }, inside);
  if (!found) {
    return dropped(base, "Measured the example: there's no coloured box at that spot.");
  }
  const template = context.allLayers.find((layer): layer is TextLayer => layer.type === "text" && layer.formatRole?.kind === "sample" && layer.formatRole.block === "body") ??
    context.allLayers.find((layer): layer is TextLayer => layer.type === "text" && layer.formatRole?.kind === "sample");
  if (!template) {
    return dropped(base, "The format has no text sample to copy the look from.");
  }
  const { rect, color } = found;
  const ink = inkColors(context.example, rect, color)[0];
  const pad = Math.round(Math.min(24, Math.max(8, rect.height * 0.18)));
  const spaceBefore = template.formatRole?.kind === "sample" ? template.formatRole.spaceBefore : 16;
  const text: TextLayer = {
    ...template,
    id: newLayerId(),
    name: "Callout sample",
    text: edit.text,
    x: Math.round(rect.x + pad),
    y: Math.round(rect.y + pad),
    wrapWidth: Math.round(rect.width - pad * 2),
    fill: ink ? toHex(ink) : template.fill,
    locked: false,
    formatRole: { kind: "sample", block: "callout", spaceBefore },
  };
  const box = boxLayer("Callout box", rect, color, "callout");
  // Draw the pair on the live canvas once to see whether it matches the example.
  const baseline = score(context, rect);
  const tried = trial(context, rect, () => {
    const shape = new Konva.Rect({ x: box.x, y: box.y, width: box.width, height: box.height, fill: box.fill, listening: false });
    const words = new Konva.Text({
      x: text.x,
      y: text.y,
      width: text.wrapWidth,
      text: text.text,
      fontFamily: text.fontFamily,
      fontSize: text.fontSize,
      fontStyle: text.fontStyle,
      fill: text.fill,
      lineHeight: text.lineHeight,
      letterSpacing: text.letterSpacing,
      listening: false,
    });
    context.contentLayer.add(shape, words);
    return () => {
      shape.destroy();
      words.destroy();
    };
  });
  return {
    ...base,
    title: `Add a callout sample on the ${toHex(color)} box`,
    verdict: gain(baseline, tried) >= MIN_GAIN ? "closer" : "measured",
    note: `Box measured in the example: ${String(Math.round(rect.width))} × ${String(Math.round(rect.height))} px; text colour ${text.fill}, in the body text's font.${gain(baseline, tried) >= MIN_GAIN ? ` ${percent(gain(baseline, tried))} closer in that area.` : ""} The box is painted out of the background art.`,
    change: { patches: [], add: [{ layers: [box, text], before: null }], remove: [] },
    paintOut: [rect],
  };
}

function resolveFlow(context: PageContext, edit: Extract<ReviewEdit, { op: "flow" }>, base: Omit<Suggestion, "verdict" | "note" | "change" | "paintOut">): Suggestion {
  const flow = context.rows.find(({ layer }) => layer.formatRole?.kind === "flow")?.layer;
  if (flow?.type !== "rect") {
    return dropped(base, "This page has no flow area.");
  }
  const left = edit.left === undefined ? flow.x : (edit.left / 1000) * context.width;
  const top = edit.top === undefined ? flow.y : (edit.top / 1000) * context.height;
  const right = edit.right === undefined ? flow.x + flow.width : (edit.right / 1000) * context.width;
  const bottom = edit.bottom === undefined ? flow.y + flow.height : (edit.bottom / 1000) * context.height;
  if (right - left < context.width * 0.2 || bottom - top < context.height * 0.15) {
    return dropped(base, "That would leave too little room for content.");
  }
  const sides = (["top", "bottom", "left", "right"] as const).filter((side) => edit[side] !== undefined).map((side) => `${side} at ${String(Math.round((edit[side] ?? 0) / 10))}%`);
  return {
    ...base,
    title: `Flow area: ${sides.join(", ")} of the page`,
    verdict: "judgment",
    note: "Where content may go is a design choice the pictures can't settle. Your call.",
    change: { patches: [{ id: flow.id, patch: { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) } }], add: [], remove: [] },
    paintOut: [],
  };
}

/** Reviews every page of the open format that has its example page as a reference layer. */
export async function reviewFormat(onProgress: (message: string) => void, options: { ai: boolean } = { ai: true }): Promise<ReviewResult> {
  const store = useEditorStore.getState();
  const design = store.design;
  if (!design) {
    throw new Error("No design open");
  }
  store.commitTransient();
  store.setEditingTextLayer(null);
  store.setEditingFrame(null);
  const originalPageId = store.activePageId;
  const allPages = syncedPages(design, originalPageId);
  const allLayers = allPages.flatMap((page) => page.layers);
  const suggestions: Suggestion[] = [];
  const notes: string[] = [];
  const answers: string[] = [];

  try {
    for (const [index, page] of allPages.entries()) {
      const reference = page.layers.find((layer): layer is ImageLayer => layer.type === "image" && layer.formatRole?.kind === "reference");
      if (!reference) {
        continue;
      }
      const pageNumber = index + 1;
      onProgress(`Page ${String(pageNumber)}: comparing with the example…`);
      useEditorStore.getState().setActivePage(page.id);
      const live = useEditorStore.getState().design;
      if (!live) {
        throw new Error("Design closed during the review");
      }
      await waitForPage(live.layers);
      const contentLayer = getContentLayer();
      if (!contentLayer) {
        throw new Error("Canvas is not ready");
      }
      const { width, height } = design;
      const exampleImage = await loadImage(`/assets/${reference.asset}`);
      const exampleCanvas = drawTo(exampleImage, width, height, page.background.startsWith("#") ? page.background : "#ffffff");
      const smallHeight = Math.round((COMPARE_WIDTH * height) / width);
      const rows: TableRow[] = live.layers
        .filter((layer) => layer.formatRole?.kind !== "reference" && layer.visible)
        .map((layer, row) => {
          const node = getLayerNode(layer.id);
          const box = node ? node.getClientRect({ skipShadow: true, skipStroke: true }) : { x: layer.x, y: layer.y, width: 0, height: 0 };
          return { short: `L${String(row + 1)}`, layer, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
        });
      const context: PageContext = {
        page,
        pageNumber,
        width,
        height,
        rows,
        example: pixelsOf(exampleCanvas),
        exampleCanvas,
        crops: new Map(),
        exampleSmall: pixelsOf(drawTo(exampleCanvas, COMPARE_WIDTH, smallHeight)),
        contentLayer,
        allLayers,
      };
      const current = renderSmall(context);
      const before = difference(current, context.exampleSmall);
      const currentCanvas = contentLayer.toCanvas({ x: 0, y: 0, width, height, pixelRatio: Math.min(1, 1024 / Math.max(width, height)) });

      // Measured fixes first: texts fitted to the example by trial.
      const fitted = new Set<string>();
      const texts = rows.filter(({ layer }) => layer.type === "text" && !layer.locked && (!layer.formatRole || layer.formatRole.kind === "sample"));
      for (const [number, row] of texts.entries()) {
        onProgress(`Page ${String(pageNumber)}: measuring text ${String(number + 1)} of ${String(texts.length)} against the example…`);
        const fit = autoFit(context, row, page.id);
        if (fit) {
          suggestions.push(fit);
          fitted.add(row.short);
        }
        // Let the page repaint the progress between texts.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!options.ai) {
        continue;
      }

      onProgress(`Page ${String(pageNumber)}: the AI is looking…`);
      const prompt = [
        `Page ${String(pageNumber)} of the format. The page is ${String(width)} × ${String(height)} px.`,
        "Layers, bottom to top. box=[x,y,width,height] on a 0-1000 grid of the page (x across, y down):",
        describeRows(rows, width, height),
      ].join("\n");
      const answer = await aiText({
        system: SYSTEM,
        prompt,
        json: true,
        temperature: 0.2,
        images: [jpegDataUrl(exampleCanvas), jpegDataUrl(currentCanvas), differenceImage(current, context.exampleSmall)],
      });
      answers.push(answer);
      const parsed = parseEdits(answer, rows);
      const rejected = parsed.rejected;
      // Texts already fitted by measurement don't need the AI's guesses at position or colour.
      const edits = parsed.edits.filter((edit) => !((edit.op === "style" || edit.op === "move") && fitted.has(edit.layer)));
      if (rejected > 0) {
        notes.push(`Page ${String(pageNumber)}: ${String(rejected)} suggestion${rejected === 1 ? "" : "s"} didn't fit the allowed edits and ${rejected === 1 ? "was" : "were"} ignored.`);
      }
      if (edits.length === 0) {
        notes.push(`Page ${String(pageNumber)}: the AI found nothing to change (${percent(1 - before)} alike).`);
      }

      for (const [number, edit] of edits.entries()) {
        onProgress(`Page ${String(pageNumber)}: checking suggestion ${String(number + 1)} of ${String(edits.length)}…`);
        const row = "layer" in edit ? rows.find((entry) => entry.short === edit.layer) : undefined;
        const base = { id: newLayerId(), pageId: page.id, pageNumber, title: row ? row.layer.name : "Callout", why: edit.why };
        let suggestion: Suggestion;
        if (edit.op === "style" && row) {
          suggestion = await resolveStyle(context, edit, row, { ...base, title: `${row.layer.name}: style` });
        } else if (edit.op === "move" && row) {
          suggestion = resolveMove(context, edit, row, { ...base, title: `${row.layer.name}: move` });
        } else if (edit.op === "role" && row) {
          suggestion = resolveRole(context, edit, row, { ...base, title: `${row.layer.name}: kind → ${edit.block}` });
        } else if (edit.op === "box" && row) {
          suggestion = resolveBox(context, row, { ...base, title: `${row.layer.name}: add its box` });
        } else if (edit.op === "callout") {
          suggestion = resolveCallout(context, edit, { ...base, title: "Add a callout sample" });
        } else if (edit.op === "remove" && row) {
          suggestion = {
            ...base,
            title: `Remove "${(row.layer as TextLayer).text.replace(/\s+/g, " ").slice(0, 40)}"`,
            verdict: "judgment",
            note: "Fixed text repeats on every page of a document. Whether it should is your call.",
            change: { patches: [], add: [], remove: [row.layer.id] },
            paintOut: [],
          };
        } else if (edit.op === "flow") {
          suggestion = resolveFlow(context, edit, { ...base, title: "Flow area" });
        } else {
          continue;
        }
        suggestions.push(suggestion);
      }
    }
  } finally {
    useEditorStore.getState().setActivePage(originalPageId);
  }
  if (!allPages.some((page) => page.layers.some((layer) => layer.formatRole?.kind === "reference"))) {
    throw new Error("This format has no example page to compare with. Formats made with \"Format from example\" keep one as a hidden reference layer.");
  }
  return { suggestions, notes, answers };
}

/** The page's background art: the bottom full-page image. */
function artLayer(page: DesignPage, width: number, height: number): ImageLayer | undefined {
  return page.layers.find((layer): layer is ImageLayer =>
    layer.type === "image" && layer.formatRole === undefined && Math.abs(layer.x) < 2 && Math.abs(layer.y) < 2 &&
    layer.width >= width * 0.95 && layer.height >= height * 0.95);
}

/** A copy of the art with areas painted in the colour around them. */
async function paintOut(art: ImageLayer, rects: Rect[], width: number, name: string): Promise<string> {
  const image = await loadImage(`/assets/${art.asset}`);
  const canvas = drawTo(image, image.naturalWidth, image.naturalHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas unavailable");
  }
  const scale = image.naturalWidth / width;
  for (const rect of rects) {
    const scaled = { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
    const around = colorAround(pixelsOf(canvas), scaled, 3);
    context.fillStyle = toHex(around);
    context.fillRect(scaled.x - 1, scaled.y - 1, scaled.width + 2, scaled.height + 2);
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => { if (result) { resolve(result); } else { reject(new Error("Couldn't encode the art")); } }, "image/jpeg", 0.9);
  });
  return (await api.uploadAsset(new File([blob], `${name} · background (reviewed).jpg`, { type: "image/jpeg" }))).asset;
}

/** Applies the accepted suggestions as one undo step. */
export async function applySuggestions(accepted: Suggestion[], onProgress: (message: string) => void): Promise<void> {
  const store = useEditorStore.getState();
  const design = store.design;
  if (!design || accepted.length === 0) {
    return;
  }
  store.commitTransient();
  let pages = syncedPages(design, store.activePageId);
  for (const page of design.pages) {
    const mine = accepted.filter((suggestion) => suggestion.pageId === page.id);
    if (mine.length === 0) {
      continue;
    }
    const changes = mine.map((suggestion) => suggestion.change);
    const rects = mine.flatMap((suggestion) => suggestion.paintOut);
    const current = pages.find((entry) => entry.id === page.id);
    const art = current ? artLayer(current, design.width, design.height) : undefined;
    if (art && rects.length > 0) {
      onProgress("Updating the background art…");
      const asset = await paintOut(art, rects, design.width, design.name);
      changes.push({ patches: [{ id: art.id, patch: { asset } }], add: [], remove: [] });
      useEditorStore.getState().bumpAssetsVersion();
    }
    pages = applyChanges(pages, page.id, changes);
  }
  useEditorStore.getState().replacePages(pages);
}
