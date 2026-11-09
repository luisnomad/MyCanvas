import { GlobalWorkerOptions, OPS, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type ResolvedFont, resolvePdfFont } from "./font-names";

GlobalWorkerOptions.workerSrc = workerUrl;

/*
 * Reads an example PDF page into what a format needs: the page without its
 * text (background art), the page as it is (reference), and the text as
 * blocks with font, size, colour, line spacing and any box behind them.
 * Units are PDF points from the page's top-left corner.
 */

export interface TextBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Font size, pt. */
  size: number;
  font: ResolvedFont;
  /** #rrggbb, measured from the rendered glyphs. */
  color: string;
  /** Baseline-to-baseline distance ÷ size (1.2 when single-line). */
  lineHeight: number;
  lines: number;
  /** A coloured rectangle behind the text, when there is one. */
  box?: { x: number; y: number; width: number; height: number; color: string };
}

export interface AnalyzedPage {
  width: number;
  height: number;
  /** Dominant colour of the page (its edges), #rrggbb. */
  background: string;
  /** The page with text removed, as JPEG. */
  art: Blob;
  /** The page as printed, as JPEG. */
  reference: Blob;
  blocks: TextBlock[];
  /** Raster pictures drawn on the page (logos, illustrations), pt. */
  pictures: { x: number; y: number; width: number; height: number }[];
}

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Where raster images land on the page, in canvas pixels (from the drawing operations). */
function picturesOf(fnArray: number[], argsArray: unknown[], viewportTransform: number[]): { x: number; y: number; width: number; height: number }[] {
  const out: { x: number; y: number; width: number; height: number }[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = viewportTransform.slice(0, 6) as Matrix;
  for (const [index, fn] of fnArray.entries()) {
    const args = argsArray[index] as unknown[] | null;
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OPS.transform && args) {
      ctm = multiply(ctm, args as Matrix);
    } else if (fn === OPS.paintFormXObjectBegin && args) {
      stack.push(ctm);
      const matrix = args[0] as Matrix | null;
      if (matrix) {
        ctm = multiply(ctm, matrix);
      }
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      // Images fill the unit square of the current transform.
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u = 0, v = 0]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]] as const);
      const xs = corners.map(([x]) => x);
      const ys = corners.map(([, y]) => y);
      out.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    }
  }
  return out;
}

/** Render scale: pixels per PDF point. */
const SCALE = 2;

interface Item {
  str: string;
  x: number;
  y: number;
  right: number;
  size: number;
  fontName: string;
  /** Weight/italic flags from the font itself, for names that don't say. */
  fontFlags: { bold: boolean; black: boolean; italic: boolean };
}

/** The font's own bold/black/italic flags fill in what its name didn't say. */
function withFlags(font: ResolvedFont, flags: Item["fontFlags"] | undefined): ResolvedFont {
  if (!flags) {
    return font;
  }
  return {
    ...font,
    weight: font.weight !== 400 ? font.weight : flags.black ? 900 : flags.bold ? 700 : 400,
    italic: font.italic || flags.italic,
  };
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** Most common colour among the given pixels (bucketed to 4 bits a channel). */
function dominant(data: Uint8ClampedArray, indexes: Iterable<number>): [number, number, number] {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (const index of indexes) {
    const r = data[index] ?? 0;
    const g = data[index + 1] ?? 0;
    const b = data[index + 2] ?? 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  let best = { count: 0, r: 255, g: 255, b: 255 };
  for (const bucket of buckets.values()) {
    if (bucket.count > best.count) {
      best = bucket;
    }
  }
  return best.count > 0 ? [best.r / best.count, best.g / best.count, best.b / best.count] : [255, 255, 255];
}

function* rectPixels(width: number, x0: number, y0: number, x1: number, y1: number, step = 1): Generator<number> {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.floor(y1); y += step) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.floor(x1)); x += step) {
      yield (y * width + x) * 4;
    }
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob) { resolve(blob); } else { reject(new Error("Couldn't encode the page")); } }, "image/jpeg", 0.9);
  });
}

/** Lines → blocks (same font and size, next line just below, overlapping horizontally). */
function groupBlocks(items: Item[]): { items: Item[]; lines: Item[][] }[] {
  // Items into lines first.
  const lines: Item[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((candidate) => {
      const last = candidate[candidate.length - 1];
      return last !== undefined && Math.abs(last.y - item.y) < item.size * 0.35 && item.x >= last.x - 1 && item.x - last.right < item.size * 1.2;
    });
    if (line) {
      line.push(item);
    } else {
      lines.push([item]);
    }
  }
  const blocks: { items: Item[]; lines: Item[][] }[] = [];
  for (const line of lines.sort((a, b) => (a[0]?.y ?? 0) - (b[0]?.y ?? 0))) {
    const head = line[0];
    if (!head) {
      continue;
    }
    const left = Math.min(...line.map((item) => item.x));
    const right = Math.max(...line.map((item) => item.right));
    const block = blocks.find((candidate) => {
      const lastLine = candidate.lines[candidate.lines.length - 1];
      const last = lastLine?.[0];
      if (!last || !lastLine) {
        return false;
      }
      const blockLeft = Math.min(...candidate.items.map((item) => item.x));
      const blockRight = Math.max(...candidate.items.map((item) => item.right));
      return last.fontName === head.fontName &&
        Math.abs(last.size - head.size) < 0.6 &&
        head.y > last.y &&
        head.y - last.y < head.size * 1.9 &&
        left < blockRight && right > blockLeft;
    });
    if (block) {
      block.lines.push(line);
      block.items.push(...line);
    } else {
      blocks.push({ items: [...line], lines: [line] });
    }
  }
  return blocks;
}

export async function analyzePdf(file: File, maxPages = 2): Promise<{ pages: AnalyzedPage[]; pageCount: number }> {
  // fontExtraProperties: keeps each font's real name ("ABCDEF+Montserrat-Black").
  const pdf = await getDocument({ data: new Uint8Array(await file.arrayBuffer()), fontExtraProperties: true }).promise;
  const pages: AnalyzedPage[] = [];
  for (let number = 1; number <= Math.min(maxPages, pdf.numPages); number++) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: SCALE });
    const make = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Canvas unavailable");
      }
      return { canvas, context };
    };
    const full = make();
    await page.render({ canvas: full.canvas, canvasContext: full.context, viewport }).promise;
    // Same page with glyph drawing switched off: everything but the text.
    // Pages with transparency draw text on scratch canvases too, so glyph
    // drawing is switched off for every 2D context, just for this render.
    const art = make();
    const proto = CanvasRenderingContext2D.prototype;
    const saved = (["fillText", "strokeText"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const);
    for (const [name] of saved) {
      Object.defineProperty(proto, name, { configurable: true, writable: true, value: () => undefined });
    }
    try {
      await page.render({ canvas: art.canvas, canvasContext: art.context, viewport }).promise;
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) {
          Object.defineProperty(proto, name, descriptor);
        }
      }
    }

    const width = full.canvas.width;
    const fullData = full.context.getImageData(0, 0, width, full.canvas.height).data;
    const artData = art.context.getImageData(0, 0, width, art.canvas.height).data;

    // Page colour: the edges of the text-free page.
    const edge: number[] = [];
    const h = art.canvas.height;
    for (let x = 0; x < width; x += 7) {
      edge.push((2 * width + x) * 4, ((h - 3) * width + x) * 4);
    }
    for (let y = 0; y < h; y += 7) {
      edge.push((y * width + 2) * 4, (y * width + width - 3) * 4);
    }
    const pageColor = dominant(artData, edge);

    // Text with real font names; pictures from the drawing operations.
    const operators = await page.getOperatorList();
    const pictures = picturesOf(operators.fnArray, operators.argsArray, viewport.transform)
      .map((rect) => ({ x: rect.x / SCALE, y: rect.y / SCALE, width: rect.width / SCALE, height: rect.height / SCALE }))
      // Not specks, and not full-page backgrounds.
      .filter((rect) => rect.width > 24 && rect.height > 24 && rect.width * rect.height < (viewport.width / SCALE) * (viewport.height / SCALE) * 0.8);
    const content = await page.getTextContent();
    const pageHeight = viewport.height / SCALE;
    const items: Item[] = content.items.flatMap((raw) => {
      if (!("str" in raw)) {
        return [];
      }
      const item = raw as { str: string; transform: number[]; width: number; fontName: string };
      if (!item.str.trim()) {
        return [];
      }
      const [a = 0, b = 0, , , e = 0, f = 0] = item.transform;
      const size = Math.hypot(a, b) || 1;
      let fontName = item.fontName;
      const fontFlags = { bold: false, black: false, italic: false };
      try {
        const font = page.commonObjs.get(item.fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean } | undefined;
        fontName = font?.name ?? item.fontName;
        fontFlags.bold = font?.bold === true;
        fontFlags.black = font?.black === true;
        fontFlags.italic = font?.italic === true;
      } catch {
        // Unresolved font: keep the internal name.
      }
      return [{ str: item.str, x: e, y: pageHeight - f, right: e + Math.max(item.width, item.str.length * size * 0.3), size, fontName, fontFlags }];
    });

    const blocks: TextBlock[] = groupBlocks(items).map(({ items: blockItems, lines }) => {
      const first = blockItems[0];
      const size = first?.size ?? 12;
      const x = Math.min(...blockItems.map((item) => item.x));
      const right = Math.max(...blockItems.map((item) => item.right));
      const top = Math.min(...blockItems.map((item) => item.y)) - size * 0.85;
      const bottom = Math.max(...blockItems.map((item) => item.y)) + size * 0.25;
      const text = lines
        .map((line) => [...line].sort((p, q) => p.x - q.x).map((item) => item.str).join(" ").replace(/\s+/g, " ").trim())
        .reduce((joined, line) => (joined === "" ? line : /[A-Za-zÀ-ÿ]-$/.test(joined) ? `${joined.slice(0, -1)}${line}` : `${joined}\n${line}`), "");
      const baselines = lines.map((line) => line[0]?.y ?? 0);
      const gaps = baselines.slice(1).map((y, index) => y - (baselines[index] ?? y)).filter((gap) => gap > 0).sort((p, q) => p - q);
      const lineHeight = gaps.length > 0 ? (gaps[Math.floor(gaps.length / 2)] ?? size * 1.2) / size : 1.2;

      // Glyph colour: pixels that changed when the text was removed.
      const changed: number[] = [];
      for (const index of rectPixels(width, x * SCALE, top * SCALE, right * SCALE, bottom * SCALE)) {
        const a: [number, number, number] = [fullData[index] ?? 0, fullData[index + 1] ?? 0, fullData[index + 2] ?? 0];
        const b: [number, number, number] = [artData[index] ?? 0, artData[index + 1] ?? 0, artData[index + 2] ?? 0];
        if (distance(a, b) > 90) {
          changed.push(index);
        }
      }
      const glyph = dominant(fullData, changed);

      // A box behind the text: the text-free page under it differs from the page colour.
      const under = dominant(artData, rectPixels(width, x * SCALE, top * SCALE, right * SCALE, bottom * SCALE, 2));
      let box: TextBlock["box"];
      if (distance(under, pageColor) > 60) {
        // Grow from the text outwards while the colour holds.
        const same = (px: number, py: number) => {
          if (px < 0 || py < 0 || px >= width || py >= h) {
            return false;
          }
          const index = (Math.floor(py) * width + Math.floor(px)) * 4;
          return distance([artData[index] ?? 0, artData[index + 1] ?? 0, artData[index + 2] ?? 0], under) < 40;
        };
        const cy = ((top + bottom) / 2) * SCALE;
        const cx = ((x + right) / 2) * SCALE;
        let left = x * SCALE;
        while (same(left - 1, cy)) {
          left -= 1;
        }
        let rightEdge = right * SCALE;
        while (same(rightEdge + 1, cy)) {
          rightEdge += 1;
        }
        let topEdge = top * SCALE;
        while (same(cx, topEdge - 1)) {
          topEdge -= 1;
        }
        let bottomEdge = bottom * SCALE;
        while (same(cx, bottomEdge + 1)) {
          bottomEdge += 1;
        }
        // A "box" covering most of the page is a background area, not a callout.
        if ((rightEdge - left) * (bottomEdge - topEdge) < width * h * 0.5) {
          box = { x: left / SCALE, y: topEdge / SCALE, width: (rightEdge - left) / SCALE, height: (bottomEdge - topEdge) / SCALE, color: hex(...under) };
        }
      }

      return {
        text,
        x,
        y: top,
        width: right - x,
        height: bottom - top,
        size,
        font: withFlags(resolvePdfFont(first?.fontName ?? ""), first?.fontFlags),
        color: hex(...glyph),
        lineHeight: Math.min(2.5, Math.max(0.8, lineHeight)),
        lines: lines.length,
        box,
      };
    });

    pages.push({
      width: viewport.width / SCALE,
      height: pageHeight,
      background: hex(...pageColor),
      art: await canvasBlob(art.canvas),
      reference: await canvasBlob(full.canvas),
      blocks,
      pictures,
    });
  }
  return { pages, pageCount: pdf.numPages };
}
