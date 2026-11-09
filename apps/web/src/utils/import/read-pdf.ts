import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type RawParagraph } from "./classify";

GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

interface Line {
  text: string;
  /** Baseline y from the page top, pt. */
  y: number;
  x: number;
  right: number;
  size: number;
  bold: boolean;
}

/** A run of lines that belong together (one paragraph-ish area on the page). */
interface Block {
  lines: Line[];
  x: number;
  right: number;
  top: number;
  bottom: number;
}

const COUNTER = /^\s*\d{1,3}\s*(?:\/\s*\d{1,3})?\s*$/;

/**
 * Text lines of one page. Items join a line when they share a baseline and
 * sit close together, so two columns at the same height stay two lines.
 */
function linesOf(items: PdfTextItem[], pageHeight: number, boldFonts: Set<string>): Line[] {
  const sorted = items
    .filter((item) => item.str.trim())
    .map((item) => {
      const [a = 0, b = 0, , , e = 0, f = 0] = item.transform;
      const size = Math.hypot(a, b) || 1;
      return { str: item.str, x: e, right: e + Math.max(item.width, item.str.length * size * 0.3), y: pageHeight - f, size, bold: boldFonts.has(item.fontName) };
    })
    .sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: (Line & { parts: string[] })[] = [];
  for (const item of sorted) {
    const line = lines.find((candidate) =>
      Math.abs(candidate.y - item.y) < Math.max(2, item.size * 0.35) &&
      item.x >= candidate.x - 1 &&
      item.x - candidate.right < Math.max(item.size, candidate.size) * 1.2);
    if (line) {
      const gap = item.x - line.right;
      line.parts.push(gap > item.size * 0.15 && !/\s$/.test(line.parts[line.parts.length - 1] ?? "") ? ` ${item.str}` : item.str);
      line.right = Math.max(line.right, item.right);
      line.size = Math.max(line.size, item.size);
      line.bold &&= item.bold;
    } else {
      lines.push({ text: "", y: item.y, x: item.x, right: item.right, size: item.size, bold: item.bold, parts: [item.str] });
    }
  }
  return lines.map(({ parts, ...line }) => ({ ...line, text: parts.join("").replace(/\s+/g, " ").trim() }));
}

/** Lines into blocks: next line just below, same style, overlapping horizontally. */
function blocksOf(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  for (const line of [...lines].sort((p, q) => p.y - q.y || p.x - q.x)) {
    const block = blocks.find((candidate) => {
      const last = candidate.lines[candidate.lines.length - 1];
      return last !== undefined &&
        Math.abs(last.size - line.size) < 0.6 &&
        last.bold === line.bold &&
        line.y > last.y &&
        line.y - last.y < line.size * 1.75 &&
        line.x < candidate.right &&
        line.right > candidate.x &&
        Math.abs(line.x - candidate.x) < line.size * 4;
    });
    if (block) {
      block.lines.push(line);
      block.x = Math.min(block.x, line.x);
      block.right = Math.max(block.right, line.right);
      block.bottom = line.y;
    } else {
      blocks.push({ lines: [line], x: line.x, right: line.right, top: line.y - line.size, bottom: line.y });
    }
  }
  return blocks;
}

/**
 * Reading order: the page is cut into horizontal bands at blocks that span
 * most of its width (titles, full-width paragraphs); inside a band, columns
 * are read left to right, each top to bottom.
 */
function readingOrder(blocks: Block[], pageWidth: number): Block[] {
  const byTop = [...blocks].sort((p, q) => p.top - q.top);
  const ordered: Block[] = [];
  let band: Block[] = [];
  const flushBand = () => {
    const columns: { x: number; right: number; blocks: Block[] }[] = [];
    for (const block of [...band].sort((p, q) => p.x - q.x)) {
      const column = columns.find((candidate) => block.x < candidate.right && block.right > candidate.x);
      if (column) {
        column.blocks.push(block);
        column.x = Math.min(column.x, block.x);
        column.right = Math.max(column.right, block.right);
      } else {
        columns.push({ x: block.x, right: block.right, blocks: [block] });
      }
    }
    for (const column of columns.sort((p, q) => p.x - q.x)) {
      ordered.push(...column.blocks.sort((p, q) => p.top - q.top));
    }
    band = [];
  };
  for (const block of byTop) {
    if (block.right - block.x > pageWidth * 0.6) {
      flushBand();
      ordered.push(block);
    } else {
      band.push(block);
    }
  }
  flushBand();
  return ordered;
}

function blockText(block: Block): string {
  return block.lines.reduce((joined, line) =>
    // A word broken with a hyphen at the line end is joined back up.
    (joined === "" ? line.text : /[A-Za-zÀ-ÿ]-$/.test(joined) ? `${joined.slice(0, -1)}${line.text}` : `${joined} ${line.text}`), "");
}

export async function readPdf(file: File, pagePerPage: boolean): Promise<{ paragraphs: RawParagraph[]; warnings: string[]; pages: number }> {
  const pdf = await getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const warnings: string[] = [];
  const pages: { blocks: Block[] }[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    // Loading the operator list makes the fonts' real names available.
    await page.getOperatorList();
    const content = await page.getTextContent();
    const items: PdfTextItem[] = content.items.flatMap((item) => ("str" in item ? [item] : []));
    const boldFonts = new Set<string>();
    for (const fontName of new Set(items.map((item) => item.fontName))) {
      try {
        const font = page.commonObjs.get(fontName) as { name?: string } | undefined;
        if (font?.name && /bold|black|heavy|semibold|demi/i.test(font.name)) {
          boldFonts.add(fontName);
        }
      } catch {
        // Font not resolved; treat as regular.
      }
    }
    const lines = linesOf(items, viewport.height, boldFonts).filter((line) => !COUNTER.test(line.text));
    pages.push({ blocks: readingOrder(blocksOf(lines), viewport.width) });
  }
  if (pages.every((page) => page.blocks.length === 0)) {
    warnings.push("This PDF has no text layer (it's scanned or flattened), so there's nothing to import. Its text would need OCR.");
    return { paragraphs: [], warnings, pages: pdf.numPages };
  }

  // Running headers/footers: the same text at the same height on most pages.
  const keyOf = (block: Block) => `${blockText(block).replace(/\d+/g, "#")}@${String(Math.round(block.top / 6))}`;
  const seen = new Map<string, number>();
  for (const page of pages) {
    for (const key of new Set(page.blocks.map(keyOf))) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const repeated = pdf.numPages >= 3 ? new Set([...seen].filter(([, count]) => count >= Math.ceil(pdf.numPages * 0.6)).map(([key]) => key)) : new Set<string>();

  const paragraphs: RawParagraph[] = [];
  for (const [index, page] of pages.entries()) {
    if (pagePerPage && index > 0) {
      paragraphs.push({ role: "pageBreak", text: "" });
    }
    for (const block of page.blocks) {
      if (repeated.has(keyOf(block))) {
        continue;
      }
      paragraphs.push({
        text: blockText(block),
        size: Math.max(...block.lines.map((line) => line.size)),
        bold: block.lines.every((line) => line.bold),
      });
    }
  }
  warnings.push("Images in PDFs aren't imported; add them from your uploads.");
  if (pdf.numPages === 1 && pages[0] && pages[0].blocks.length > 40) {
    warnings.push("This looks like a designed one-page layout (poster or infographic): check the reading order.");
  }
  return { paragraphs, warnings, pages: pdf.numPages };
}
