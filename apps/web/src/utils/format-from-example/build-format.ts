import {
  type BlockKind,
  type DesignPage,
  type ImageLayer,
  type Layer,
  type RectLayer,
  type TextLayer,
  defaultShadow,
  defaultStroke,
  formatFontStyle,
} from "@mycanvas/shared";
import { api } from "../../api";
import { newLayerId } from "../../store/editorStore";
import { type AnalyzedPage, type TextBlock } from "./analyze-pdf";
import { type ExampleRoles, classifyExample } from "./classify-example";

/** PDF points → design pixels (96 dpi). */
const K = 96 / 72;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BuiltFormat {
  width: number;
  height: number;
  pages: DesignPage[];
  /** What each block kind looks like, for the summary. */
  roles: { kind: BlockKind; label: string; font: string; exactFont: boolean; color: string; text: string }[];
  warnings: string[];
}

async function loadCanvas(blob: Blob): Promise<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas unavailable");
  }
  context.drawImage(bitmap, 0, 0);
  return { canvas, context };
}

function toBlob(canvas: HTMLCanvasElement, type = "image/jpeg"): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob) { resolve(blob); } else { reject(new Error("Couldn't encode image")); } }, type, 0.9);
  });
}

async function upload(blob: Blob, name: string): Promise<string> {
  const extension = blob.type === "image/png" ? ".png" : ".jpg";
  return (await api.uploadAsset(new File([blob], `${name}${extension}`, { type: blob.type }))).asset;
}

/** Colour just around a rectangle (to paint it out of the background). */
function surroundingColor(context: CanvasRenderingContext2D, rect: Rect, scale: number): string {
  const x = Math.max(0, Math.floor(rect.x * scale) - 4);
  const y = Math.max(0, Math.floor(rect.y * scale) - 4);
  const w = Math.min(context.canvas.width - x, Math.ceil(rect.width * scale) + 8);
  const h = Math.min(context.canvas.height - y, Math.ceil(rect.height * scale) + 8);
  const data = context.getImageData(x, y, w, h).data;
  const counts = new Map<string, number>();
  const ring = (px: number, py: number) => {
    const index = (py * w + px) * 4;
    const key = [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0].map((value) => (value >> 3) << 3).join(",");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let px = 0; px < w; px++) {
    ring(px, 0);
    ring(px, h - 1);
  }
  for (let py = 0; py < h; py++) {
    ring(0, py);
    ring(w - 1, py);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "255,255,255";
  return `rgb(${best})`;
}

function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) {
    return null;
  }
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function baseLayer(name: string, x: number, y: number) {
  return { id: newLayerId(), name, x, y, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true };
}

function textLayer(name: string, block: TextBlock, text: string, size: number, lineHeight: number, wrapWidth: number): TextLayer {
  return {
    ...baseLayer(name, block.x * K, block.y * K),
    type: "text",
    text,
    fontFamily: block.font.use,
    fontSize: Math.round(size * K * 10) / 10,
    fontStyle: formatFontStyle({ weight: block.font.weight, italic: block.font.italic }),
    fill: block.color,
    align: "left",
    lineHeight: Math.round(lineHeight * 100) / 100,
    letterSpacing: 0,
    wrapWidth: Math.round(wrapWidth),
    effect: { type: "none" },
    shadow: defaultShadow(),
    stroke: defaultStroke(),
  };
}

const LABELS: Record<Exclude<BlockKind, "image">, string> = {
  title: "Title",
  lead: "Lead",
  heading: "Heading",
  body: "Body text",
  callout: "Callout",
};

/**
 * Builds a format from an analysed example: masters from its first pages
 * (art without text, flow area, samples where the example had them).
 */
export async function buildFormat(analyzed: AnalyzedPage[], baseName: string, onProgress: (message: string) => void): Promise<BuiltFormat> {
  const roles: ExampleRoles = classifyExample(analyzed);
  const warnings: string[] = [];
  const first = analyzed[0];
  if (!first) {
    throw new Error("The example has no pages.");
  }
  if (!roles.samples.body) {
    throw new Error("No text found to learn from. Is the PDF scanned or flattened?");
  }

  const pages: DesignPage[] = [];
  let imageSampleDone = false;
  // Cast: assigned later in the loop, so TS must not narrow it to null.
  let firstFlow = null as Rect | null;

  for (const [index, page] of analyzed.entries()) {
    onProgress(`Building master page ${String(index + 1)}…`);
    const content = roles.content[index] ?? [];
    const furniture = roles.furniture.filter((entry) => entry.page === index).map((entry) => entry.block);
    // Pictures in the text area are example content; the rest (logos, footers) is decoration.
    const contentPictures = page.pictures.filter((picture) => {
      const middle = picture.y + picture.height / 2;
      return middle > page.height * 0.08 && middle < page.height * 0.9;
    });

    const art = await loadCanvas(page.art);
    const scale = art.canvas.width / page.width;
    // Lift content pictures out of the background; the first becomes the image sample.
    let imageSample: ImageLayer | null = null;
    for (const picture of contentPictures) {
      if (!imageSampleDone) {
        const crop = document.createElement("canvas");
        crop.width = Math.round(picture.width * scale);
        crop.height = Math.round(picture.height * scale);
        crop.getContext("2d")?.drawImage(art.canvas, picture.x * scale, picture.y * scale, picture.width * scale, picture.height * scale, 0, 0, crop.width, crop.height);
        const asset = await upload(await toBlob(crop), `${baseName} · picture`);
        imageSample = {
          ...baseLayer("Image sample", picture.x * K, picture.y * K),
          type: "image",
          asset,
          width: picture.width * K,
          height: picture.height * K,
          shadow: defaultShadow(),
          formatRole: { kind: "sample", block: "image", spaceBefore: 18 },
        };
        imageSampleDone = true;
      }
      art.context.fillStyle = surroundingColor(art.context, picture, scale);
      art.context.fillRect(picture.x * scale - 1, picture.y * scale - 1, picture.width * scale + 2, picture.height * scale + 2);
    }
    // Callout boxes come back as box layers, so they leave the background too.
    for (const block of content) {
      if (block.box) {
        art.context.fillStyle = surroundingColor(art.context, block.box, scale);
        art.context.fillRect(block.box.x * scale - 1, block.box.y * scale - 1, block.box.width * scale + 2, block.box.height * scale + 2);
      }
    }
    const artAsset = await upload(await toBlob(art.canvas), `${baseName} · background ${String(index + 1)}`);
    const referenceAsset = await upload(page.reference, `${baseName} · example page ${String(index + 1)}`);

    // Flow area: where the example's content sits, down to the footer.
    const contentRects: Rect[] = [...content.map((block) => block.box ?? block), ...contentPictures];
    let flow = union(contentRects);
    const footerTop = Math.min(
      ...furniture.filter((block) => block.y > page.height / 2).map((block) => block.y),
      ...page.pictures.filter((picture) => picture.y > page.height * 0.85).map((picture) => picture.y),
      page.height,
    );
    if (flow) {
      const margin = Math.max(18, flow.x);
      const bottom = Math.min(footerTop - 12, page.height - margin);
      flow = { ...flow, height: Math.max(flow.height, bottom - flow.y) };
    } else if (firstFlow) {
      flow = { ...firstFlow, y: Math.min(firstFlow.y, page.height * 0.08) };
      flow.height = Math.min(footerTop - 12, page.height - flow.x) - flow.y;
    } else {
      flow = { x: page.width * 0.08, y: page.height * 0.08, width: page.width * 0.84, height: page.height * 0.82 };
    }
    firstFlow ??= flow;
    const flowRight = (flow.x + flow.width) * K;

    const layers: Layer[] = [
      { ...baseLayer("Background art (from example)", 0, 0), type: "image", asset: artAsset, width: page.width * K, height: page.height * K, shadow: defaultShadow(), locked: true },
      {
        ...baseLayer("Flow area", flow.x * K, flow.y * K),
        type: "rect",
        width: flow.width * K,
        height: flow.height * K,
        fill: "#ffffff",
        cornerRadius: 0,
        stroke: defaultStroke(),
        shadow: defaultShadow(),
        opacity: 0.06,
        formatRole: { kind: "flow" },
      } satisfies RectLayer,
    ];

    for (const [kind, sample] of Object.entries(roles.samples) as [Exclude<BlockKind, "image">, NonNullable<ExampleRoles["samples"]["body"]>][]) {
      if (sample.page !== index) {
        continue;
      }
      const block = sample.block;
      const box = block.box;
      let wrap = flowRight - block.x * K;
      if (box) {
        const padLeft = block.x - box.x;
        wrap = (box.x + box.width - padLeft - block.x) * K;
        layers.push({
          ...baseLayer(`${LABELS[kind]} box`, box.x * K, box.y * K),
          type: "rect",
          width: box.width * K,
          height: box.height * K,
          fill: box.color,
          cornerRadius: 0,
          stroke: defaultStroke(),
          shadow: defaultShadow(),
          formatRole: { kind: "box", block: kind },
        } satisfies RectLayer);
      }
      const text = textLayer(`${LABELS[kind]} sample`, block, sample.text, sample.size, sample.lineHeight, wrap);
      text.formatRole = { kind: "sample", block: kind, spaceBefore: Math.round(sample.spaceBefore * K) };
      layers.push(text);
    }
    if (imageSample) {
      layers.push(imageSample);
    }
    for (const block of furniture) {
      layers.push(textLayer("Page text (from example)", block, block.text, block.size, block.lineHeight, block.width * K + 6));
    }
    layers.push({
      ...baseLayer("Example page (reference)", 0, 0),
      type: "image",
      asset: referenceAsset,
      width: page.width * K,
      height: page.height * K,
      shadow: defaultShadow(),
      visible: false,
      locked: true,
      formatRole: { kind: "reference" },
    });

    pages.push({ id: newLayerId(), background: page.background, layers });
  }

  const roleList: BuiltFormat["roles"] = [];
  for (const [kind, sample] of Object.entries(roles.samples) as [Exclude<BlockKind, "image">, NonNullable<ExampleRoles["samples"]["body"]>][]) {
    const font = sample.block.font;
    roleList.push({
      kind,
      label: LABELS[kind],
      font: `${font.use} ${String(font.weight)}${font.italic ? " italic" : ""}`,
      exactFont: font.exact,
      color: sample.block.color,
      text: sample.text.split("\n")[0] ?? "",
    });
    if (!font.exact) {
      warnings.push(`${LABELS[kind]}: the example uses "${font.family}", which isn't available; using ${font.use} instead.`);
    }
  }
  for (const kind of ["title", "heading", "lead", "callout"] as const) {
    if (!roles.samples[kind]) {
      warnings.push(`No ${LABELS[kind].toLowerCase()} found in the example; it will use another block's look until you add a sample.`);
    }
  }
  return { width: Math.round(first.width * K), height: Math.round(first.height * K), pages, roles: roleList, warnings: [...new Set(warnings)] };
}
