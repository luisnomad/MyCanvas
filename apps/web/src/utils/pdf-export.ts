import fontkit from "@pdf-lib/fontkit";
import { customFace } from "./custom-fonts";
import Konva from "konva";
import {
  type PDFFont,
  type PDFImage,
  type PDFPage,
  LineCapStyle,
  LineJoinStyle,
  PDFContentStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  type PDFRef,
  TextRenderingMode,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  appendBezierCurve,
  clip,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endPath,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSpacing,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from "pdf-lib";
import { type ImageAdjustments, type Layer, type PageContent, type TextLayer, parseFontStyle } from "@mycanvas/shared";
import { useEditorStore } from "../store/editorStore";
import { TEXT_MAIN_NAME } from "./behind-text";
import { getContentLayer, getLayerNode } from "./canvas-bridge";
import { ensureFontsLoaded, isGoogleFont } from "./fonts";
import { cssFilterFor, hasAdjustments } from "./image-filters";
import { type PictureKind, type PicturePlacement, type Rect, flipMatrix, framePlacement, fullPictureRect, imagePlacement, jpegExifOrientation, pictureMatrix, sniffPicture } from "./pdf-picture";
import { type Band, arcPath, curveArc, curveTextPad, curvedGlyphs, effectOffset, straightBands, textFallbackReason } from "./pdf-text";
import { type PathCommand, type Rgba, type ShadingSpec, type VectorShape, type VectorStroke, backgroundShape, layerMatrix, parseCssColor, pathBounds, pdfLayerMatrix, shadowVisible, vectorShapeForLayer } from "./pdf-vector";
import { padTrueTypeGlyphs } from "./ttf-even-glyphs";
import { assetUrl } from "./endpoints";

/**
 * Multi-page PDF export with real text.
 *
 * Each page becomes a stack of slices in z-order:
 * - text layers are drawn as PDF text with the font embedded (subset), at
 *   the exact baselines Konva uses — crisp, searchable and copyable; the
 *   outline, echo, glitch and background effects are extra passes or
 *   shapes under the text, and curved text places each glyph along the
 *   editor's arc (see pdf-text.ts);
 * - rects, shapes and lines without a shadow are drawn as PDF paths from
 *   the design model (see pdf-vector.ts), with the geometry the editor
 *   draws; gradients are native axial/radial shadings, as is a gradient
 *   page background (a solid one is a rectangle);
 * - photos and filled frames embed the original file untouched, at full
 *   resolution, clipped to the crop or the frame shape (see pdf-picture.ts);
 *   a filtered photo embeds its filtered pixels at the photo's own size;
 * - a shadow or glow is the one soft thing left: it is rendered by Konva
 *   as a picture of just that effect (the layer drawn with and without it,
 *   subtracted) under the layer's own vector, text or picture slice;
 * - everything else is rendered by Konva itself into image slices cropped
 *   to their content, so it looks exactly like the editor.
 * A text layer whose font file isn't available, or that uses characters
 * the font lacks, falls back to an image slice.
 */

/** PDF points per design pixel (96 px per inch, like Canva/browsers). */
const POINTS_PER_PX = 72 / 96;

export interface PdfExportOptions {
  /** Raster slice resolution relative to the design size. */
  pixelRatio: number;
  onProgress?: (page: number, total: number) => void;
}

type Slice =
  | { kind: "raster"; nodes: Konva.Node[]; withBackground: boolean }
  | { kind: "text"; layer: TextLayer; node: TextNode }
  | { kind: "vector"; shape: VectorShape }
  | { kind: "picture"; placement: PicturePlacement; image: HTMLImageElement; asset: string; adjust?: ImageAdjustments; node: Konva.Node }
  /**
   * The soft part of a layer (shadow, glow) alone, drawn under the layer's
   * own vector/text/picture slice. "shadow": the shadow layer recovered from
   * the node rendered with and without it; "glow": the group with the text
   * hidden.
   */
  | { kind: "effect"; node: Konva.Node; pad: number; mode: "shadow" | "glow"; prepare: () => () => void };

interface PictureFile {
  bytes: Uint8Array;
  kind: PictureKind | null;
  /** JPEG EXIF orientation; anything but 1 needs re-encoding from the decoded pixels. */
  orientation: number;
}

/** Asset files, fetched and embedded once per export. */
class PictureSource {
  private readonly files = new Map<string, Promise<PictureFile | null>>();
  private readonly originals = new Map<string, Promise<PDFImage | null>>();

  constructor(private readonly pdf: PDFDocument) {}

  file(asset: string): Promise<PictureFile | null> {
    let file = this.files.get(asset);
    if (!file) {
      file = fetch(assetUrl(asset))
        .then(async (res) => {
          if (!res.ok) {
            return null;
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          const kind = sniffPicture(bytes);
          return { bytes, kind, orientation: kind === "jpeg" ? jpegExifOrientation(bytes) : 1 };
        })
        .catch(() => null);
      this.files.set(asset, file);
    }
    return file;
  }

  /** The untouched original, embedded once; null when pdf-lib can't take the file as is. */
  original(asset: string): Promise<PDFImage | null> {
    let image = this.originals.get(asset);
    if (!image) {
      image = this.file(asset).then(async (file) => {
        if (!file?.kind || file.orientation !== 1) {
          return null;
        }
        try {
          return file.kind === "jpeg" ? await this.pdf.embedJpg(file.bytes) : await this.pdf.embedPng(file.bytes);
        } catch {
          return null;
        }
      });
      this.originals.set(asset, image);
    }
    return image;
  }
}

/** Longest side / pixel count of a picture render (memory). */
const MAX_PICTURE_SIDE = 8192;
const MAX_PICTURE_PIXELS = 32_000_000;

/**
 * The source rect of `image`, through the layer's filters, at the picture's
 * own resolution (never the page's). Blur gets the editor's mirrored-edge
 * padding so borders don't fade. `blurScale` is picture px per design px.
 */
function renderPicture(image: HTMLImageElement, source: Rect, adjust: ImageAdjustments | undefined, blurScale: number, asJpeg: boolean): { dataUrl: string; kind: PictureKind } | null {
  const ratio = Math.min(1, MAX_PICTURE_SIDE / Math.max(source.width, source.height), Math.sqrt(MAX_PICTURE_PIXELS / (source.width * source.height)));
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) {
    return null;
  }
  const blurPx = (adjust?.blur ?? 0) * blurScale * ratio;
  const filter = hasAdjustments(adjust) ? cssFilterFor(adjust, blurScale * ratio) : "none";
  if (blurPx > 0) {
    const pad = Math.min(Math.ceil(blurPx * 3), width, height);
    const padded = document.createElement("canvas");
    padded.width = width + pad * 2;
    padded.height = height + pad * 2;
    const pctx = padded.getContext("2d");
    if (!pctx) {
      return null;
    }
    pctx.translate(pad, pad);
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        pctx.save();
        pctx.translate(i === 1 ? width * 2 : 0, j === 1 ? height * 2 : 0);
        pctx.scale(i === 0 ? 1 : -1, j === 0 ? 1 : -1);
        pctx.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, width, height);
        pctx.restore();
      }
    }
    ctx.filter = filter;
    ctx.drawImage(padded, -pad, -pad);
  } else {
    ctx.filter = filter;
    ctx.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, width, height);
  }
  return asJpeg ? { dataUrl: out.toDataURL("image/jpeg", 0.92), kind: "jpeg" } : { dataUrl: out.toDataURL("image/png"), kind: "png" };
}

function pathOperators(path: PathCommand[]): PDFOperator[] {
  return path.map((command) =>
    command.op === "M"
      ? moveTo(command.x, command.y)
      : command.op === "L"
        ? lineTo(command.x, command.y)
        : command.op === "C"
          ? appendBezierCurve(command.x1, command.y1, command.x2, command.y2, command.x, command.y)
          : closePath(),
  );
}

/**
 * A photo or filled frame: the picture under the layer transform, clipped
 * to the crop box or frame shape. False when it couldn't be embedded (the
 * caller rasterizes the node instead).
 */
async function drawPicture(pdf: PDFDocument, page: PDFPage, slice: Extract<Slice, { kind: "picture" }>, pictures: PictureSource, designHeight: number): Promise<boolean> {
  const { placement, image, asset, adjust } = slice;
  const pictureWidth = image.naturalWidth;
  const pictureHeight = image.naturalHeight;
  let embedded: PDFImage | null = null;
  let rect: Rect = placement.target;
  if (!hasAdjustments(adjust)) {
    embedded = await pictures.original(asset);
    if (embedded) {
      rect = fullPictureRect(placement, pictureWidth, pictureHeight);
    }
  }
  if (!embedded) {
    // Filtered, EXIF-rotated, or a format PDF lacks: the source pixels at their own size.
    const file = await pictures.file(asset);
    const render = renderPicture(image, placement.source, adjust, placement.source.width / placement.target.width, file?.kind === "jpeg");
    if (!render) {
      return false;
    }
    try {
      embedded = render.kind === "jpeg" ? await pdf.embedJpg(render.dataUrl) : await pdf.embedPng(render.dataUrl);
    } catch {
      return false;
    }
  }
  const [a, b, c, d, e, f] = pdfLayerMatrix(placement.matrix, designHeight, POINTS_PER_PX);
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f)];
  const state = alphaState(pdf, page, placement.opacity, placement.opacity);
  if (state) {
    ops.push(setGraphicsState(state));
  }
  ops.push(...pathOperators(placement.clip), clip(), endPath());
  if (placement.content) {
    ops.push(concatTransformationMatrix(...placement.content));
  }
  const flip = flipMatrix(placement);
  if (flip) {
    ops.push(concatTransformationMatrix(...flip));
  }
  const [pa, pb, pc, pd, pe, pf] = pictureMatrix(rect);
  ops.push(concatTransformationMatrix(pa, pb, pc, pd, pe, pf), drawObject(page.node.newXObject("Im", embedded.ref)), popGraphicsState());
  page.pushOperators(...ops);
  return true;
}

/**
 * Waits for the next paint. Hidden tabs pause animation frames, so a timer
 * stands in — an export keeps going if the tab is switched mid-way.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

type TextNode = Konva.Text | Konva.TextPath;

let measureCanvas: HTMLCanvasElement | null = null;

/** Konva's own measurement of `text` in the node's font (width, and the font's box for the "middle" baseline). */
function measureText(node: TextNode, text: string): { width: number; ascent: number; descent: number } {
  const fontSize = node.fontSize();
  measureCanvas ??= document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) {
    return { width: 0, ascent: fontSize * 0.8, descent: fontSize * 0.2 };
  }
  ctx.font = (node as unknown as { _getContextFont: () => string })._getContextFont();
  const metrics = ctx.measureText(text);
  const box = metrics as { fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number; actualBoundingBoxAscent?: number; actualBoundingBoxDescent?: number };
  return {
    width: metrics.width,
    ascent: box.fontBoundingBoxAscent ?? box.actualBoundingBoxAscent ?? fontSize * 0.8,
    descent: box.fontBoundingBoxDescent ?? box.actualBoundingBoxDescent ?? fontSize * 0.2,
  };
}

/** Waits until every image on the open page has loaded and fonts are ready. */
export async function waitForPage(layers: Layer[]): Promise<void> {
  await nextFrame();
  await nextFrame();
  await ensureFontsLoaded(layers.filter((layer): layer is TextLayer => layer.type === "text"));
  const deadline = Date.now() + 15000;
  for (;;) {
    const pending = layers.some((layer) => {
      if (!layer.visible || (layer.type !== "image" && !(layer.type === "frame" && layer.content))) {
        return false;
      }
      const node = getLayerNode(layer.id);
      const image = node instanceof Konva.Image ? node : node instanceof Konva.Group ? node.findOne<Konva.Image>("Image") : undefined;
      const source = image?.image();
      return !(source instanceof HTMLImageElement ? source.complete && source.naturalWidth > 0 : source);
    });
    if (!pending || Date.now() > deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await nextFrame();
  getContentLayer()?.draw();
}

/** Typical style names of installed faces, per weight. */
const LOCAL_WEIGHT_NAMES: Record<number, string[]> = {
  100: ["thin", "hairline"],
  200: ["extralight", "extra light", "ultralight", "ultra light"],
  300: ["light"],
  400: ["regular", "normal", "book", "roman", ""],
  500: ["medium"],
  600: ["semibold", "semi bold", "demibold", "demi bold"],
  700: ["bold"],
  800: ["extrabold", "extra bold", "ultrabold", "ultra bold", "heavy"],
  900: ["black", "heavy"],
};

/** Whether an installed face's style name ("Light Italic", "Bold") is this weight/italic. */
function localFaceMatches(style: string, weight: number, italic: boolean): boolean {
  const lower = style.toLowerCase().trim();
  const isItalic = /italic|oblique/.test(lower);
  if (isItalic !== italic) {
    return false;
  }
  const name = lower.replace(/\s*(italic|oblique)\s*/g, "").trim();
  return (LOCAL_WEIGHT_NAMES[weight] ?? []).includes(name);
}

/** Font files for PDF embedding: Google Fonts via our server, else this machine's own fonts. */
class FontSource {
  private readonly cache = new Map<string, Promise<PDFFont | null>>();

  constructor(private readonly pdf: PDFDocument) {}

  get(layer: TextLayer): Promise<PDFFont | null> {
    const { weight, italic } = parseFontStyle(layer.fontStyle);
    const key = `${layer.fontFamily}|${String(weight)}|${String(italic)}`;
    let font = this.cache.get(key);
    if (!font) {
      font = this.load(layer.fontFamily, weight, italic).then(async (bytes) => {
        if (!bytes) {
          return null;
        }
        try {
          // Even glyph lengths: fontkit's subset writes a short loca that
          // truncates odd offsets and loses glyphs (see ttf-even-glyphs.ts).
          return await this.pdf.embedFont(padTrueTypeGlyphs(new Uint8Array(bytes)), { subset: true });
        } catch {
          return null;
        }
      });
      this.cache.set(key, font);
    }
    return font;
  }

  private async load(family: string, weight: number, italic: boolean): Promise<ArrayBuffer | null> {
    // Fonts uploaded into MyCanvas come first: same file as on the canvas.
    const custom = customFace(family, weight, italic);
    if (custom) {
      const res = await fetch(`/fonts/${encodeURIComponent(custom.id)}`);
      return res.ok ? res.arrayBuffer() : null;
    }
    if (isGoogleFont(family)) {
      const res = await fetch(`/api/fonts/file?family=${encodeURIComponent(family)}&weight=${String(weight)}&italic=${italic ? "1" : "0"}`);
      return res.ok ? res.arrayBuffer() : null;
    }
    const query = (window as { queryLocalFonts?: () => Promise<{ family: string; style: string; blob: () => Promise<Blob> }[]> }).queryLocalFonts;
    if (!query) {
      return null;
    }
    try {
      const candidates = (await query()).filter((font) => font.family === family);
      const match = candidates.find((font) => localFaceMatches(font.style, weight, italic));
      return match ? await (await match.blob()).arrayBuffer() : null;
    } catch {
      return null;
    }
  }
}

/** True when `font` has a glyph for every character of `text`. */
function fontCovers(font: PDFFont, text: string): boolean {
  const embedded = (font as unknown as { embedder?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } }).embedder?.font;
  if (!embedded?.hasGlyphForCodePoint) {
    return true;
  }
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp !== undefined && cp > 32 && !embedded.hasGlyphForCodePoint(cp)) {
      return false;
    }
  }
  return true;
}

interface FontkitGlyphRun {
  glyphs: { advanceWidth: number }[];
  positions: { xAdvance: number }[];
}

interface FontkitFont {
  unitsPerEm: number;
  layout: (text: string, features?: Record<string, boolean>) => FontkitGlyphRun;
}

/**
 * A line as positioned runs of text. The browser kerns pairs like "AV" when
 * letter spacing is 0 (Konva draws letter by letter otherwise, without
 * kerning); PDF text has no kerning of its own, so the line is split
 * wherever a pair is kerned and each run starts at its exact x.
 */
function layoutLine(font: PDFFont, text: string, fontSize: number, letterSpacing: number) {
  const fontkitFont = (font as unknown as { embedder?: { font?: FontkitFont } }).embedder?.font;
  const chars = [...text];
  if (!fontkitFont || letterSpacing !== 0) {
    const width = font.widthOfTextAtSize(text, fontSize) + letterSpacing * Math.max(0, chars.length - 1);
    return { runs: [{ text, x: 0 }], width };
  }
  // Ligatures off so glyphs map one-to-one to characters.
  const run = fontkitFont.layout(text, { liga: false, clig: false, kern: true });
  if (run.glyphs.length !== chars.length) {
    return { runs: [{ text, x: 0 }], width: font.widthOfTextAtSize(text, fontSize) };
  }
  const scale = fontSize / fontkitFont.unitsPerEm;
  const runs: { text: string; x: number }[] = [];
  let x = 0;
  let current = { text: "", x: 0 };
  chars.forEach((char, index) => {
    current.text += char;
    const plain = run.glyphs[index]?.advanceWidth ?? 0;
    const actual = run.positions[index]?.xAdvance ?? plain;
    x += actual * scale;
    if (actual !== plain && index < chars.length - 1) {
      runs.push(current);
      current = { text: "", x };
    }
  });
  runs.push(current);
  return { runs: runs.filter((entry) => entry.text !== ""), width: x };
}

/** One paint of the text: fill, optional stroke, offset in text-local px. */
interface TextPaint {
  fill: Rgba;
  stroke?: { color: Rgba; width: number; miterLimit: number };
  dx: number;
  dy: number;
}

const fontKeys = new WeakMap<PDFPage, Map<PDFFont, PDFName>>();

/** The font's resource name on `page` (registered once per page). */
function fontKey(page: PDFPage, font: PDFFont): PDFName {
  let keys = fontKeys.get(page);
  if (!keys) {
    keys = new Map();
    fontKeys.set(page, keys);
  }
  let key = keys.get(font);
  if (!key) {
    key = page.node.newFontDictionary(font.name, font.ref);
    keys.set(font, key);
  }
  return key;
}

const GLITCH_COLORS: Record<string, [string, string]> = {
  "cyan-magenta": ["#00e5ff", "#ff00c8"],
  "red-blue": ["#ff2d2d", "#2d6bff"],
};

/**
 * A text layer as real PDF text: the effect passes LayerNode stacks
 * (outline copy, echo copies, glitch copies, background bands) and then
 * the text itself, each at Konva's own glyph positions.
 */
function drawTextLayer(pdf: PDFDocument, page: PDFPage, slice: Extract<Slice, { kind: "text" }>, font: PDFFont, designHeight: number) {
  const { layer, node } = slice;
  const fill = parseCssColor(layer.fill);
  if (!fill) {
    return;
  }
  const effect = layer.effect ?? { type: "none" as const };
  const curved = node instanceof Konva.TextPath;
  // Konva.Text strokes with miter limit 2; TextPath keeps the canvas default.
  const miterLimit = curved ? 10 : 2;
  const { dx, dy } = effectOffset(effect);
  const passes: TextPaint[] = [];
  const main: TextPaint = { fill, dx: 0, dy: 0 };
  if (effect.type === "outline") {
    const color = parseCssColor(effect.color) ?? fill;
    // Stroke-only copy at 2x thickness under the fill copy, as the editor draws it.
    passes.push({ fill: color, stroke: { color, width: effect.thickness * 2, miterLimit }, dx: 0, dy: 0 });
  } else if (effect.type === "echo") {
    const color = parseCssColor(effect.color) ?? fill;
    passes.push({ fill: color, dx: dx * 2, dy: dy * 2 }, { fill: color, dx, dy });
  } else if (effect.type === "glitch") {
    const [a, b] = GLITCH_COLORS[effect.colorPair] ?? GLITCH_COLORS["cyan-magenta"] ?? ["#00e5ff", "#ff00c8"];
    passes.push({ fill: parseCssColor(a) ?? fill, dx, dy }, { fill: parseCssColor(b) ?? fill, dx: -dx, dy: -dy });
  }
  passes.push(main);

  const fontSize = node.fontSize();
  const letterSpacing = node.letterSpacing();
  const box = measureText(node, "M");
  // Konva draws with textBaseline "middle": the baseline sits this far below the line/path point.
  const middleToBaseline = (box.ascent - box.descent) / 2;
  // The text node sits inside the layer's group, which carries layer opacity.
  const opacity = node.opacity() * (node.getParent()?.opacity() ?? 1);
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = node.getAbsoluteTransform().getMatrix();
  const k = POINTS_PER_PX;

  // Glyph placements in text-local space (y down): origin on the line/path, rotation along it.
  const placements: { text: string; x: number; y: number; rotation: number }[] = [];
  if (curved) {
    const text = node.text();
    const chars = [...text].map((char) => ({ text: char, width: measureText(node, char).width }));
    const textWidth = chars.reduce((total, char) => total + char.width, 0) + Math.max(0, chars.length - 1) * letterSpacing;
    const arc = curveArc(textWidth, fontSize, layer.curve ?? 0, curveTextPad(textWidth, letterSpacing));
    if (arc) {
      placements.push(...curvedGlyphs(chars, measureText(node, text).width, letterSpacing, arc));
    }
  } else {
    const lineHeightPx = node.lineHeight() * fontSize;
    const padding = node.padding();
    const totalWidth = node.width();
    const firstBaseline = middleToBaseline + lineHeightPx / 2;
    node.textArr.forEach((line, index) => {
      const text = line.text.replace(/\s+$/, "");
      if (!text) {
        return;
      }
      const { runs, width: pdfWidth } = layoutLine(font, text, fontSize, letterSpacing);
      // Align by the embedded font's own width so centers/right edges stay put.
      const available = totalWidth - padding * 2;
      const x = layer.align === "center" ? padding + (available - pdfWidth) / 2 : layer.align === "right" ? padding + available - pdfWidth : padding;
      const baseline = padding + firstBaseline + index * lineHeightPx;
      for (const run of runs) {
        // Straight runs carry their own baseline offset: rotation 0, origin on the baseline.
        placements.push({ text: run.text, x: x + run.x, y: baseline - middleToBaseline, rotation: 0 });
      }
    });
  }

  // Background bands go under everything, in the layer group's space.
  if (effect.type === "background") {
    const color = parseCssColor(effect.color);
    if (color) {
      const bandOpacity = Math.min(1, Math.max(0, effect.opacity)) * opacity;
      const stroke = (width: number, cap: VectorStroke["cap"], join: VectorStroke["join"]): VectorStroke => ({ color, width, cap, join });
      const matrix = layerMatrix(layer);
      const shapes: VectorShape[] = [];
      if (curved) {
        const text = node.text();
        const chars = [...text].map((char) => measureText(node, char).width);
        const textWidth = chars.reduce((total, width) => total + width, 0) + Math.max(0, chars.length - 1) * letterSpacing;
        const arc = curveArc(textWidth, fontSize, layer.curve ?? 0);
        if (arc) {
          const cap = effect.roundness >= 50 ? "round" : effect.roundness >= 20 ? "square" : "butt";
          shapes.push({ matrix, path: arcPath(arc), fill: null, stroke: stroke(fontSize + effect.spread, cap, effect.roundness >= 50 ? "round" : "miter"), opacity: bandOpacity, group: false });
        }
      } else {
        const bands: Band[] = straightBands(node.textArr.map((line) => line.width), layer, effect);
        for (const band of bands) {
          shapes.push({ matrix, path: [{ op: "M", x: band.x0, y: band.y }, { op: "L", x: band.x1, y: band.y }], fill: null, stroke: stroke(band.width, band.cap, "miter"), opacity: bandOpacity, group: false });
        }
      }
      for (const shape of shapes) {
        drawVector(pdf, page, shape, designHeight);
      }
    }
  }

  const key = fontKey(page, font);
  for (const pass of passes) {
    const ops: PDFOperator[] = [
      pushGraphicsState(),
      // Text-local (x right, y down) → PDF (y up), in points.
      concatTransformationMatrix(k * a, -k * b, -k * c, k * d, k * e, k * (designHeight - f)),
    ];
    const state = alphaState(pdf, page, pass.fill.a * opacity, (pass.stroke?.color.a ?? 1) * opacity);
    if (state) {
      ops.push(setGraphicsState(state));
    }
    ops.push(beginText(), setFontAndSize(key, fontSize), setCharacterSpacing(curved ? 0 : letterSpacing));
    ops.push(setFillingRgbColor(pass.fill.r, pass.fill.g, pass.fill.b));
    if (pass.stroke) {
      ops.push(
        setTextRenderingMode(TextRenderingMode.FillAndOutline),
        setStrokingRgbColor(pass.stroke.color.r, pass.stroke.color.g, pass.stroke.color.b),
        setLineWidth(pass.stroke.width),
        setLineJoin(LineJoinStyle.Miter),
        PDFOperator.of(PDFOperatorNames.SetLineMiterLimit, [PDFNumber.of(pass.stroke.miterLimit)]),
      );
    } else {
      ops.push(setTextRenderingMode(TextRenderingMode.Fill));
    }
    for (const glyph of placements) {
      // Baseline origin: the placement point plus the middle→baseline drop, in the glyph's own frame.
      const cos = Math.cos(glyph.rotation);
      const sin = Math.sin(glyph.rotation);
      const ox = glyph.x + pass.dx - sin * middleToBaseline;
      const oy = glyph.y + pass.dy + cos * middleToBaseline;
      // The cm above is y-down → y-up: local (x, y) lands at (x, -y), a y-down rotation φ becomes -φ.
      ops.push(setTextMatrix(cos, -sin, sin, cos, ox, -oy), showText(font.encodeText(glyph.text)));
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }
}

/** An ExtGState with these alphas, on `page`'s resources; null when both are 1. */
function alphaState(pdf: PDFDocument, page: PDFPage, fillAlpha: number, strokeAlpha: number): PDFName | null {
  if (fillAlpha >= 1 && strokeAlpha >= 1) {
    return null;
  }
  const ref = pdf.context.register(pdf.context.obj({ Type: "ExtGState", ca: fillAlpha, CA: strokeAlpha }));
  return page.node.newExtGState("GS", ref);
}

/** A PDF shading (axial or radial, DeviceRGB) with its stop function, registered in the document. */
function shadingRef(pdf: PDFDocument, spec: ShadingSpec): PDFRef {
  const rgb3 = (color: Rgba) => [color.r, color.g, color.b];
  const first = spec.stops[0] ?? { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } };
  const last = spec.stops[spec.stops.length - 1] ?? first;
  // The function must cover 0…1: hold the end colors outside the stops.
  const stops = [...(first.offset > 0 ? [{ offset: 0, color: first.color }] : []), ...spec.stops, ...(last.offset < 1 ? [{ offset: 1, color: last.color }] : [])];
  const segment = (from: Rgba, to: Rgba) => pdf.context.register(pdf.context.obj({ FunctionType: 2, Domain: [0, 1], C0: rgb3(from), C1: rgb3(to), N: 1 }));
  let fn: PDFRef;
  if (stops.length === 2) {
    fn = segment(stops[0]?.color ?? first.color, stops[1]?.color ?? last.color);
  } else {
    const functions: PDFRef[] = [];
    const bounds: number[] = [];
    const encode: number[] = [];
    for (let i = 1; i < stops.length; i += 1) {
      functions.push(segment(stops[i - 1]?.color ?? first.color, stops[i]?.color ?? last.color));
      if (i < stops.length - 1) {
        // Hard stops (equal offsets) need strictly increasing bounds.
        const previous = bounds[bounds.length - 1] ?? 0;
        bounds.push(Math.max(stops[i]?.offset ?? 0, previous + 1e-4));
      }
      encode.push(0, 1);
    }
    fn = pdf.context.register(pdf.context.obj({ FunctionType: 3, Domain: [0, 1], Functions: functions, Bounds: bounds, Encode: encode }));
  }
  return pdf.context.register(pdf.context.obj({
    ShadingType: spec.type === "axial" ? 2 : 3,
    ColorSpace: "DeviceRGB",
    Coords: spec.coords,
    Function: fn,
    // Canvas pads both ends with the end colors.
    Extend: [true, true],
  }));
}

let shadingCount = 0;

/** Adds `ref` to the /Shading resources of `resources` under a fresh name. */
function shadingName(pdf: PDFDocument, resources: PDFDict, ref: PDFRef): PDFName {
  const key = PDFName.of("Shading");
  const existing = resources.lookup(key);
  const dict: PDFDict = existing instanceof PDFDict ? existing : pdf.context.obj({});
  if (dict !== existing) {
    resources.set(key, dict);
  }
  shadingCount += 1;
  const name = PDFName.of(`Sh${String(shadingCount)}`);
  dict.set(name, ref);
  return name;
}

/**
 * Path construction plus paint for a vector shape (alphas already in the
 * graphics state). A gradient fill clips to the path and paints the
 * shading (`shading` names it in the current resources).
 */
function shapeOperators(shape: VectorShape, shading: PDFName | null): PDFOperator[] {
  const ops: PDFOperator[] = [];
  const { fill: fillColor, stroke: strokeStyle } = shape;
  if (shading) {
    ops.push(pushGraphicsState(), ...pathOperators(shape.path), clip(), endPath(), PDFOperator.of(PDFOperatorNames.ShadingFill, [shading]), popGraphicsState());
    if (!strokeStyle) {
      return ops;
    }
  }
  ops.push(...pathOperators(shape.path));
  if (fillColor) {
    ops.push(setFillingRgbColor(fillColor.r, fillColor.g, fillColor.b));
  }
  if (strokeStyle) {
    const cap = strokeStyle.cap === "round" ? LineCapStyle.Round : strokeStyle.cap === "square" ? LineCapStyle.Projecting : LineCapStyle.Butt;
    // Canvas defaults: miter joins, miter limit 10 (also PDF's default).
    ops.push(
      setStrokingRgbColor(strokeStyle.color.r, strokeStyle.color.g, strokeStyle.color.b),
      setLineWidth(strokeStyle.width),
      setLineCap(cap),
      setLineJoin(strokeStyle.join === "round" ? LineJoinStyle.Round : strokeStyle.join === "bevel" ? LineJoinStyle.Bevel : LineJoinStyle.Miter),
    );
  }
  ops.push(fillColor && strokeStyle ? fillAndStroke() : fillColor ? fill() : stroke());
  return ops;
}

/**
 * A rect/shape/line as PDF paths in its own local space under the layer's
 * transform. Fill+stroke under opacity goes through a transparency group,
 * matching Konva's buffered draw.
 */
function drawVector(pdf: PDFDocument, page: PDFPage, shape: VectorShape, designHeight: number) {
  if ((!shape.fill && !shape.gradient && !shape.stroke) || shape.opacity <= 0 || shape.path.length === 0) {
    return;
  }
  const [a, b, c, d, e, f] = pdfLayerMatrix(shape.matrix, designHeight, POINTS_PER_PX);
  const fillAlpha = shape.gradient ? shape.gradient.alpha : (shape.fill?.a ?? 1);
  const strokeAlpha = shape.stroke?.color.a ?? 1;
  const shading = shape.gradient ? shadingRef(pdf, shape.gradient) : null;
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f)];
  if (shape.group) {
    // Inner alphas live in the group; the group is composited at layer opacity.
    const inner: PDFOperator[] = [];
    const resources: Record<string, unknown> = {};
    if (fillAlpha < 1 || strokeAlpha < 1) {
      const ref = pdf.context.register(pdf.context.obj({ Type: "ExtGState", ca: fillAlpha, CA: strokeAlpha }));
      resources.ExtGState = { GS0: ref };
      inner.push(setGraphicsState("GS0"));
    }
    if (shading) {
      resources.Shading = { Sh0: shading };
    }
    inner.push(...shapeOperators(shape, shading ? PDFName.of("Sh0") : null));
    // Generous box: strokes, round caps and miters stay inside it.
    const pad = (shape.stroke?.width ?? 0) * 6 + 2;
    const dict = pdf.context.obj({
      Type: "XObject",
      Subtype: "Form",
      BBox: pathBounds(shape.path, pad),
      Group: { S: "Transparency", CS: "DeviceRGB" },
      Resources: resources as never,
    });
    const form = pdf.context.register(PDFContentStream.of(dict, inner));
    const name = page.node.newXObject("Fm", form);
    const outer = alphaState(pdf, page, shape.opacity, shape.opacity);
    if (outer) {
      ops.push(setGraphicsState(outer));
    }
    ops.push(drawObject(name));
  } else {
    const state = alphaState(pdf, page, fillAlpha * shape.opacity, strokeAlpha * shape.opacity);
    if (state) {
      ops.push(setGraphicsState(state));
    }
    ops.push(...shapeOperators(shape, shading ? shadingName(pdf, page.node.normalizedEntries().Resources, shading) : null));
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
}

/** Renders `nodes` (and nothing else) of the content layer into an image slice. */
function rasterize(contentLayer: Konva.Layer, slice: Extract<Slice, { kind: "raster" }>, width: number, height: number, pixelRatio: number, forcedBox?: { x: number; y: number; width: number; height: number }) {
  const keep = new Set(slice.nodes);
  const saved = contentLayer.getChildren().map((child) => [child, child.opacity()] as const);
  // Hide by opacity, not visibility: overlays that read other nodes' state
  // (e.g. the outlined-text-behind-subject pass) must keep seeing them.
  for (const [child, opacity] of saved) {
    child.opacity(keep.has(child) ? opacity : 0);
  }
  try {
    let box = forcedBox ?? { x: 0, y: 0, width, height };
    if (!forcedBox && !slice.withBackground) {
      const rects = slice.nodes.map((node) => node.getClientRect());
      const x0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.x))));
      const y0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.y))));
      const x1 = Math.min(width, Math.ceil(Math.max(...rects.map((r) => r.x + r.width))));
      const y1 = Math.min(height, Math.ceil(Math.max(...rects.map((r) => r.y + r.height))));
      if (x1 <= x0 || y1 <= y0) {
        return null;
      }
      box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    // An opaque full page compresses far better as JPEG; slices keep alpha.
    const opaque = slice.withBackground && slice.nodes.some((node) => node.name() === "canvas-background");
    const dataUrl = contentLayer.toDataURL({ ...box, pixelRatio, mimeType: opaque ? "image/jpeg" : "image/png", quality: 0.92 });
    return { box, dataUrl, opaque };
  } finally {
    for (const [child, opacity] of saved) {
      child.opacity(opacity);
    }
  }
}

function isShape(node: Konva.Node): node is Konva.Shape {
  return node instanceof Konva.Shape;
}

/** The node and every shape under it. */
function descendantShapes(node: Konva.Node): Konva.Shape[] {
  if (isShape(node)) {
    return [node];
  }
  if (node instanceof Konva.Container) {
    const children = node.getChildren() as Konva.Node[];
    return children.flatMap(descendantShapes);
  }
  return [];
}

function loadDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { resolve(image); };
    image.onerror = () => { reject(new Error("Could not decode a rendered slice")); };
    image.src = dataUrl;
  });
}

/** Turns off the shadows of a node's shapes for one render. Returns the undo. */
function withoutShadows(node: Konva.Node): () => void {
  const restores: (() => void)[] = [];
  for (const shape of descendantShapes(node)) {
    if (shape.shadowEnabled()) {
      shape.shadowEnabled(false);
      restores.push(() => { shape.shadowEnabled(true); });
    }
  }
  return () => {
    restores.forEach((restore) => { restore(); });
  };
}

/** Hides a text group's own glyphs for one render, leaving its glow copy. Returns the undo. */
function withoutMainText(node: Konva.Node): () => void {
  const restores: (() => void)[] = [];
  if (node instanceof Konva.Container) {
    for (const child of node.getChildren() as Konva.Node[]) {
      if (child.name() === TEXT_MAIN_NAME) {
        const opacity = child.opacity();
        child.opacity(0);
        restores.push(() => { child.opacity(opacity); });
      }
    }
  }
  return () => {
    restores.forEach((restore) => { restore(); });
  };
}

/**
 * The shadow layer alone. Canvas composites a shape over its own shadow in
 * one draw (A = B over S, with B the shape alone and S the shadow at the
 * shape's alpha), so in premultiplied terms S = (A − B) / (1 − αB). That
 * holds for Konva's buffered draws too (fill+stroke under opacity): there
 * the shape is opaque in the buffer and no shadow is left under it.
 */
function shadowLayer(full: HTMLImageElement, bare: HTMLImageElement): HTMLCanvasElement | null {
  const width = full.naturalWidth;
  const height = full.naturalHeight;
  const read = (image: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.drawImage(image, 0, 0);
    return { canvas, ctx, data: ctx.getImageData(0, 0, width, height) };
  };
  const a = read(full);
  const b = read(bare);
  if (!a || !b) {
    return null;
  }
  const out = a.ctx.createImageData(width, height);
  const A = a.data.data;
  const B = b.data.data;
  const S = out.data;
  for (let i = 0; i < A.length; i += 4) {
    const alphaA = (A[i + 3] ?? 0) / 255;
    const alphaB = (B[i + 3] ?? 0) / 255;
    const keep = 1 - alphaB;
    if (keep < 0.02) {
      continue; // under the shape: nothing of the shadow is left to show
    }
    const alphaS = Math.min(1, Math.max(0, (alphaA - alphaB) / keep));
    if (alphaS <= 0) {
      continue;
    }
    for (let c = 0; c < 3; c += 1) {
      const premultiplied = ((A[i + c] ?? 0) * alphaA - (B[i + c] ?? 0) * alphaB) / keep;
      S[i + c] = Math.min(255, Math.max(0, Math.round(premultiplied / alphaS)));
    }
    S[i + 3] = Math.round(alphaS * 255);
  }
  a.ctx.putImageData(out, 0, 0);
  return a.canvas;
}

/** How far a layer's soft effect may reach past Konva's client rect. */
function softEffectPad(node: Konva.Node, layer: Layer): number {
  let blur = 0;
  for (const shape of descendantShapes(node)) {
    blur = Math.max(blur, shape.shadowEnabled() ? shape.shadowBlur() : 0);
  }
  if (layer.type === "text" && layer.effect?.type === "glow") {
    blur = Math.max(blur, layer.effect.spread + (layer.effect.blur ?? 20) * 2);
  }
  return Math.ceil(blur) + 4;
}

/** Whether the layer has a soft effect that gets its own picture under the layer. */
function hasSoftEffect(layer: Layer): boolean {
  if (layer.type === "text") {
    return layer.effect?.type === "shadow" || layer.effect?.type === "glow";
  }
  return layer.type !== "frame" && shadowVisible(layer.shadow);
}

/**
 * The soft effect alone: the node rendered with and without it, the
 * latter subtracted, at the export's pixel ratio.
 */
async function drawEffect(pdf: PDFDocument, page: PDFPage, slice: Extract<Slice, { kind: "effect" }>, contentLayer: Konva.Layer, size: { width: number; height: number }, pixelRatio: number) {
  const rect = slice.node.getClientRect();
  const x0 = Math.max(0, Math.floor(rect.x - slice.pad));
  const y0 = Math.max(0, Math.floor(rect.y - slice.pad));
  const x1 = Math.min(size.width, Math.ceil(rect.x + rect.width + slice.pad));
  const y1 = Math.min(size.height, Math.ceil(rect.y + rect.height + slice.pad));
  if (x1 <= x0 || y1 <= y0) {
    return;
  }
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const only: Extract<Slice, { kind: "raster" }> = { kind: "raster", nodes: [slice.node], withBackground: false };
  const render = (prepare?: () => () => void) => {
    const restore = prepare?.();
    try {
      return rasterize(contentLayer, only, size.width, size.height, pixelRatio, box);
    } finally {
      restore?.();
    }
  };
  let dataUrl: string;
  if (slice.mode === "glow") {
    const glow = render(slice.prepare);
    if (!glow) {
      return;
    }
    dataUrl = glow.dataUrl;
  } else {
    const full = render();
    if (!full) {
      return;
    }
    const bare = render(slice.prepare);
    if (!bare) {
      return;
    }
    const [fullImage, bareImage] = await Promise.all([loadDataUrl(full.dataUrl), loadDataUrl(bare.dataUrl)]);
    const shadow = shadowLayer(fullImage, bareImage);
    if (!shadow) {
      return;
    }
    dataUrl = shadow.toDataURL("image/png");
  }
  const embedded = await pdf.embedPng(dataUrl);
  const k = POINTS_PER_PX;
  page.drawImage(embedded, { x: box.x * k, y: (size.height - box.y - box.height) * k, width: box.width * k, height: box.height * k });
}

/** Builds the open page's slices in z-order. */
async function sliceOpenPage(
  page: Pick<PageContent, "background" | "backgroundGradient" | "layers">,
  size: { width: number; height: number },
  fonts: FontSource,
  contentLayer: Konva.Layer,
): Promise<{ slices: Slice[]; fontFor: Map<TextLayer, PDFFont> }> {
  const layers = page.layers;
  const fontFor = new Map<TextLayer, PDFFont>();
  const vector = new Map<Konva.Node, { layer: TextLayer; node: TextNode }>();
  for (const layer of layers) {
    if (layer.type !== "text" || !layer.visible || textFallbackReason(layer) !== null) {
      continue;
    }
    const group = getLayerNode(layer.id);
    const main = group instanceof Konva.Container ? group.findOne<TextNode>(`.${TEXT_MAIN_NAME}`) : undefined;
    const isText = main instanceof Konva.Text || main instanceof Konva.TextPath;
    const font = isText ? await fonts.get(layer) : null;
    if (group && isText && font && fontCovers(font, layer.text)) {
      fontFor.set(layer, font);
      vector.set(group, { layer, node: main });
    }
  }
  const shapes = new Map<Konva.Node, VectorShape>();
  for (const layer of layers) {
    if (!layer.visible || (layer.type !== "rect" && layer.type !== "shape" && layer.type !== "line")) {
      continue;
    }
    const node = getLayerNode(layer.id);
    const shape = vectorShapeForLayer(layer);
    if (node && shape) {
      shapes.set(node, shape);
    }
  }
  const pictures = new Map<Konva.Node, Extract<Slice, { kind: "picture" }>>();
  for (const layer of layers) {
    if (!layer.visible || (layer.type !== "image" && layer.type !== "frame")) {
      continue;
    }
    const node = getLayerNode(layer.id);
    if (!node) {
      continue;
    }
    if (layer.type === "image") {
      // Outlined text behind a cutout is an overlay reading other nodes: raster.
      if (layer.cutout && layer.behindText) {
        continue;
      }
      const image = node instanceof Konva.Image ? node.image() : undefined;
      if (image instanceof HTMLImageElement && image.naturalWidth > 0) {
        pictures.set(node, { kind: "picture", placement: imagePlacement(layer, image.naturalWidth, image.naturalHeight), image, asset: layer.asset, adjust: layer.adjust, node });
      }
      continue;
    }
    const content = layer.content;
    const picture = node instanceof Konva.Container ? node.findOne<Konva.Image>("Image") : undefined;
    const image = picture?.image();
    if (content && image instanceof HTMLImageElement && image.naturalWidth > 0) {
      const placement = framePlacement(layer, image.naturalWidth, image.naturalHeight);
      if (placement) {
        pictures.set(node, { kind: "picture", placement, image, asset: content.asset, adjust: layer.adjust, node });
      }
    }
  }
  // Content-layer children in z-order. Unregistered helpers (the background
  // rect, per-layer overlays) travel with the node right before them.
  // Soft effects of layers that got a vector/text/picture slice: a picture of just the effect, under it.
  const effects = new Map<Konva.Node, Extract<Slice, { kind: "effect" }>>();
  for (const layer of layers) {
    if (!layer.visible || !hasSoftEffect(layer)) {
      continue;
    }
    const node = getLayerNode(layer.id);
    if (node && (vector.has(node) || shapes.has(node) || pictures.has(node))) {
      const glow = layer.type === "text" && layer.effect?.type === "glow";
      effects.set(node, { kind: "effect", node, pad: softEffectPad(node, layer), mode: glow ? "glow" : "shadow", prepare: () => (glow ? withoutMainText(node) : withoutShadows(node)) });
    }
  }
  const slices: Slice[] = [];
  let raster: Extract<Slice, { kind: "raster" }> | null = null;
  for (const child of contentLayer.getChildren()) {
    const effect = effects.get(child);
    if (effect) {
      raster = null;
      slices.push(effect);
    }
    if (child.name() === "canvas-background") {
      const background = backgroundShape(page.background, page.backgroundGradient, size.width, size.height);
      if (background) {
        raster = null;
        slices.push({ kind: "vector", shape: background });
        continue;
      }
    }
    const text = vector.get(child);
    if (text) {
      raster = null;
      slices.push({ kind: "text", ...text });
      continue;
    }
    const shape = shapes.get(child);
    if (shape) {
      raster = null;
      slices.push({ kind: "vector", shape });
      continue;
    }
    const picture = pictures.get(child);
    if (picture) {
      raster = null;
      slices.push(picture);
      continue;
    }
    if (!raster) {
      raster = { kind: "raster", nodes: [], withBackground: slices.length === 0 };
      slices.push(raster);
    }
    raster.nodes.push(child);
  }
  return { slices, fontFor };
}

export async function exportDesignPdf(options: PdfExportOptions): Promise<Uint8Array> {
  const store = useEditorStore.getState();
  const design = store.design;
  if (!design) {
    throw new Error("No design open");
  }
  store.commitTransient();
  store.setEditingTextLayer(null);
  store.setEditingFrame(null);
  const originalPageId = store.activePageId;
  const pageIds = design.pages.map((page) => page.id);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(design.name);
  pdf.setCreator("MyCanvas");
  pdf.setProducer("MyCanvas (pdf-lib)");
  const fonts = new FontSource(pdf);
  const pictures = new PictureSource(pdf);
  const k = POINTS_PER_PX;

  try {
    for (const [index, pageId] of pageIds.entries()) {
      options.onProgress?.(index + 1, pageIds.length);
      useEditorStore.getState().setActivePage(pageId);
      const live = useEditorStore.getState().design;
      if (!live) {
        throw new Error("Design closed during export");
      }
      await waitForPage(live.layers);
      const contentLayer = getContentLayer();
      if (!contentLayer) {
        throw new Error("Canvas is not ready");
      }
      const page = pdf.addPage([design.width * k, design.height * k]);
      const { slices, fontFor } = await sliceOpenPage(live, { width: design.width, height: design.height }, fonts, contentLayer);
      for (const slice of slices) {
        if (slice.kind === "text") {
          const font = fontFor.get(slice.layer);
          if (font) {
            drawTextLayer(pdf, page, slice, font, design.height);
          }
          continue;
        }
        if (slice.kind === "vector") {
          drawVector(pdf, page, slice.shape, design.height);
          continue;
        }
        if (slice.kind === "effect") {
          await drawEffect(pdf, page, slice, contentLayer, { width: design.width, height: design.height }, options.pixelRatio);
          continue;
        }
        let raster: Extract<Slice, { kind: "raster" }>;
        if (slice.kind === "picture") {
          if (await drawPicture(pdf, page, slice, pictures, design.height)) {
            continue;
          }
          raster = { kind: "raster", nodes: [slice.node], withBackground: false };
        } else {
          raster = slice;
        }
        const image = rasterize(contentLayer, raster, design.width, design.height, options.pixelRatio);
        if (!image) {
          continue;
        }
        const embedded = image.opaque ? await pdf.embedJpg(image.dataUrl) : await pdf.embedPng(image.dataUrl);
        page.drawImage(embedded, {
          x: image.box.x * k,
          y: (design.height - image.box.y - image.box.height) * k,
          width: image.box.width * k,
          height: image.box.height * k,
        });
      }
    }
  } finally {
    useEditorStore.getState().setActivePage(originalPageId);
  }
  return pdf.save();
}
