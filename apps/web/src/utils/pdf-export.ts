import fontkit from "@pdf-lib/fontkit";
import Konva from "konva";
import {
  type PDFFont,
  type PDFImage,
  type PDFName,
  type PDFOperator,
  type PDFPage,
  LineCapStyle,
  LineJoinStyle,
  PDFContentStream,
  PDFDocument,
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
  rgb,
  setCharacterSpacing,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from "pdf-lib";
import { type ImageAdjustments, type Layer, type TextLayer, parseFontStyle } from "@mycanvas/shared";
import { useEditorStore } from "../store/editorStore";
import { TEXT_MAIN_NAME } from "./behind-text";
import { getContentLayer, getLayerNode } from "./canvas-bridge";
import { ensureFontsLoaded, isGoogleFont } from "./fonts";
import { cssFilterFor, hasAdjustments } from "./image-filters";
import { type PictureKind, type PicturePlacement, type Rect, flipMatrix, framePlacement, fullPictureRect, imagePlacement, jpegExifOrientation, pictureMatrix, sniffPicture } from "./pdf-picture";
import { type PathCommand, type VectorShape, pathBounds, pdfLayerMatrix, shadowVisible, vectorShapeForLayer } from "./pdf-vector";
import { padTrueTypeGlyphs } from "./ttf-even-glyphs";

/**
 * Multi-page PDF export with real text.
 *
 * Each page becomes a stack of slices in z-order:
 * - plain text layers (no effect, not curved) are drawn as PDF text with
 *   the font embedded (subset), at the exact baselines Konva uses — crisp,
 *   searchable and copyable;
 * - rects, shapes and lines with solid paint (no gradient or shadow) are
 *   drawn as PDF paths from the design model (see pdf-vector.ts), with the
 *   geometry the editor draws;
 * - photos and filled frames embed the original file untouched, at full
 *   resolution, clipped to the crop or the frame shape (see pdf-picture.ts);
 *   a filtered photo embeds its filtered pixels at the photo's own size;
 * - everything else (background, styled or curved text, gradients, shadows,
 *   effects) is rendered by Konva itself into image slices cropped to their
 *   content, so it looks exactly like the editor.
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
  | { kind: "text"; layer: TextLayer; node: Konva.Text }
  | { kind: "vector"; shape: VectorShape }
  | { kind: "picture"; placement: PicturePlacement; image: HTMLImageElement; asset: string; adjust?: ImageAdjustments; node: Konva.Node };

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
      file = fetch(`/assets/${asset}`)
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

function hexToRgb(hex: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match?.[1] ? parseInt(match[1], 16) : 0;
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
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

/** Text drawn as real PDF text, line by line, at Konva's own baselines. */
function drawText(page: PDFPage, slice: Extract<Slice, { kind: "text" }>, font: PDFFont, designHeight: number) {
  const { layer, node } = slice;
  const fontSize = node.fontSize();
  const lineHeightPx = node.lineHeight() * fontSize;
  const padding = node.padding();
  const totalWidth = node.width();
  const letterSpacing = node.letterSpacing();
  // Same baseline math as Konva.Text (non-legacy rendering).
  const measured: unknown = node.measureSize("M");
  const metrics = measured as { fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number; actualBoundingBoxAscent?: number; actualBoundingBoxDescent?: number };
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? fontSize * 0.8;
  const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? fontSize * 0.2;
  const firstBaseline = (ascent - descent) / 2 + lineHeightPx / 2;
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = node.getAbsoluteTransform().getMatrix();
  const k = POINTS_PER_PX;
  const color = hexToRgb(layer.fill);
  // The text node sits inside the layer's group, which carries layer opacity.
  const opacity = node.opacity() * (node.getParent()?.opacity() ?? 1);

  page.pushOperators(
    pushGraphicsState(),
    // Text-local (x right, y down) → PDF (y up), in points.
    concatTransformationMatrix(k * a, -k * b, -k * c, k * d, k * e, k * (designHeight - f)),
    setCharacterSpacing(letterSpacing),
  );
  node.textArr.forEach((line, index) => {
    const text = line.text.replace(/\s+$/, "");
    if (!text) {
      return;
    }
    const { runs, width: pdfWidth } = layoutLine(font, text, fontSize, letterSpacing);
    // Align by the embedded font's own width so centers/right edges stay put.
    const lineLeft = padding;
    const available = totalWidth - padding * 2;
    const x = layer.align === "center"
      ? lineLeft + (available - pdfWidth) / 2
      : layer.align === "right"
        ? lineLeft + available - pdfWidth
        : lineLeft;
    const baseline = padding + firstBaseline + index * lineHeightPx;
    for (const run of runs) {
      page.drawText(run.text, { x: x + run.x, y: -baseline, size: fontSize, font, color, opacity });
    }
  });
  page.pushOperators(popGraphicsState());
}

/** An ExtGState with these alphas, on `page`'s resources; null when both are 1. */
function alphaState(pdf: PDFDocument, page: PDFPage, fillAlpha: number, strokeAlpha: number): PDFName | null {
  if (fillAlpha >= 1 && strokeAlpha >= 1) {
    return null;
  }
  const ref = pdf.context.register(pdf.context.obj({ Type: "ExtGState", ca: fillAlpha, CA: strokeAlpha }));
  return page.node.newExtGState("GS", ref);
}

/** Path construction plus paint for a vector shape (alphas already in the graphics state). */
function shapeOperators(shape: VectorShape): PDFOperator[] {
  const ops: PDFOperator[] = pathOperators(shape.path);
  const { fill: fillColor, stroke: strokeStyle } = shape;
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
      setLineJoin(LineJoinStyle.Miter),
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
  if ((!shape.fill && !shape.stroke) || shape.opacity <= 0 || shape.path.length === 0) {
    return;
  }
  const [a, b, c, d, e, f] = pdfLayerMatrix(shape.matrix, designHeight, POINTS_PER_PX);
  const fillAlpha = shape.fill?.a ?? 1;
  const strokeAlpha = shape.stroke?.color.a ?? 1;
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
    inner.push(...shapeOperators(shape));
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
    ops.push(...shapeOperators(shape));
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
}

/** Renders `nodes` (and nothing else) of the content layer into an image slice. */
function rasterize(contentLayer: Konva.Layer, slice: Extract<Slice, { kind: "raster" }>, width: number, height: number, pixelRatio: number) {
  const keep = new Set(slice.nodes);
  const saved = contentLayer.getChildren().map((child) => [child, child.opacity()] as const);
  // Hide by opacity, not visibility: overlays that read other nodes' state
  // (e.g. the outlined-text-behind-subject pass) must keep seeing them.
  for (const [child, opacity] of saved) {
    child.opacity(keep.has(child) ? opacity : 0);
  }
  try {
    let box = { x: 0, y: 0, width, height };
    if (!slice.withBackground) {
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

/** Builds the open page's slices in z-order. */
async function sliceOpenPage(layers: Layer[], fonts: FontSource, contentLayer: Konva.Layer): Promise<{ slices: Slice[]; fontFor: Map<TextLayer, PDFFont> }> {
  const fontFor = new Map<TextLayer, PDFFont>();
  const vector = new Map<Konva.Node, { layer: TextLayer; node: Konva.Text }>();
  for (const layer of layers) {
    if (layer.type !== "text" || !layer.visible || (layer.curve ?? 0) !== 0 || (layer.effect && layer.effect.type !== "none")) {
      continue;
    }
    const group = getLayerNode(layer.id);
    const main = group instanceof Konva.Container ? group.findOne<Konva.Text>(`.${TEXT_MAIN_NAME}`) : undefined;
    const font = main instanceof Konva.Text ? await fonts.get(layer) : null;
    if (group && main instanceof Konva.Text && font && fontCovers(font, layer.text) && /^#?[0-9a-f]{6}$/i.test(layer.fill)) {
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
      if (shadowVisible(layer.shadow) || (layer.cutout && layer.behindText)) {
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
  const slices: Slice[] = [];
  let raster: Extract<Slice, { kind: "raster" }> | null = null;
  for (const child of contentLayer.getChildren()) {
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
      const { slices, fontFor } = await sliceOpenPage(live.layers, fonts, contentLayer);
      for (const slice of slices) {
        if (slice.kind === "text") {
          const font = fontFor.get(slice.layer);
          if (font) {
            drawText(page, slice, font, design.height);
          }
          continue;
        }
        if (slice.kind === "vector") {
          drawVector(pdf, page, slice.shape, design.height);
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
