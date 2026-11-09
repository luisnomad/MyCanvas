import Konva from "konva";
import {
  type BlockKind,
  type Design,
  type DesignPage,
  type ImageLayer,
  type Layer,
  type RectLayer,
  type TextLayer,
} from "@mycanvas/shared";
import { loadAssetSize } from "../components/uploads/library";
import { clonePageContent, newLayerId } from "../store/editorStore";
import { type ContentBlock, type ContentItem } from "./content-markdown";
import { ensureFontsLoaded } from "./fonts";

export { CONTENT_SYNTAX, parseContent } from "./content-markdown";
export type { ContentBlock, ContentItem } from "./content-markdown";

/* ------------------------------------------------------------------------ */
/* Format: masters, flow areas and block styles                            */
/* ------------------------------------------------------------------------ */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Master {
  page: DesignPage;
  flow: Box;
  /** Index of the flow rectangle among the page's layers (content goes there in z-order). */
  flowIndex: number;
}

interface TextStyle {
  type: "text";
  sample: TextLayer;
  spaceBefore: number;
  /** Space from the flow area's left/right edges to the text. */
  insetLeft: number;
  insetRight: number;
  box?: {
    layer: RectLayer;
    /** Box edges relative to the flow area's edges. */
    insetLeft: number;
    insetRight: number;
    padTop: number;
    padBottom: number;
  };
}

interface ImageStyle {
  type: "image";
  sample: ImageLayer | null;
  spaceBefore: number;
  insetLeft: number;
  /** Image width; null = the flow area's full width. */
  width: number | null;
}

type BlockStyle = TextStyle | ImageStyle;

export interface FormatInfo {
  first: Master;
  next: Master;
  styles: Map<BlockKind, BlockStyle>;
  /** Things the format is missing; generation still works with fallbacks. */
  problems: string[];
}

const FALLBACKS: Record<BlockKind, BlockKind[]> = {
  title: ["heading", "lead", "body"],
  lead: ["body"],
  heading: ["lead", "body"],
  body: ["lead"],
  callout: ["body"],
  image: [],
};

function boundsOf(layer: { x: number; y: number; width: number; height: number; scaleX: number; scaleY: number }): Box {
  return { x: layer.x, y: layer.y, width: layer.width * layer.scaleX, height: layer.height * layer.scaleY };
}

/** A text layer with its scale baked into font size and wrap width. */
function unscaledText(layer: TextLayer): TextLayer {
  return {
    ...layer,
    fontSize: layer.fontSize * layer.scaleY,
    wrapWidth: layer.wrapWidth * layer.scaleX,
    scaleX: 1,
    scaleY: 1,
  };
}

function textNode(sample: TextLayer, text: string, width: number): Konva.Text {
  return new Konva.Text({
    text,
    fontFamily: sample.fontFamily,
    fontSize: sample.fontSize,
    fontStyle: sample.fontStyle,
    lineHeight: sample.lineHeight,
    letterSpacing: sample.letterSpacing,
    align: sample.align,
    width: Math.max(1, width),
  });
}

/** The format's masters and block styles, read from its layers' roles. */
export function readFormat(format: Design): FormatInfo {
  const problems: string[] = [];
  const masterOf = (page: DesignPage): Master | null => {
    const flowIndex = page.layers.findIndex((layer) => layer.formatRole?.kind === "flow" && layer.type === "rect");
    const flowLayer = page.layers[flowIndex];
    if (flowLayer?.type !== "rect") {
      return null;
    }
    return { page, flow: boundsOf(flowLayer), flowIndex };
  };

  const firstPage = format.pages[0];
  if (!firstPage) {
    throw new Error("The format has no pages");
  }
  let first = masterOf(firstPage);
  if (!first) {
    problems.push("Page 1 has no flow area: content uses the page minus 8% margins.");
    const marginX = format.width * 0.08;
    const marginY = format.height * 0.08;
    first = {
      page: firstPage,
      flow: { x: marginX, y: marginY, width: format.width - 2 * marginX, height: format.height - 2 * marginY },
      flowIndex: firstPage.layers.length,
    };
  }
  const secondPage = format.pages[1];
  let next = first;
  if (secondPage) {
    const master = masterOf(secondPage);
    if (master) {
      next = master;
    } else {
      problems.push("Page 2 has no flow area, so following pages repeat page 1.");
    }
  }

  // Samples: the first one of each kind wins, on any page.
  const styles = new Map<BlockKind, BlockStyle>();
  for (const page of format.pages) {
    const flow = (masterOf(page) ?? first).flow;
    for (const layer of page.layers) {
      const role = layer.formatRole;
      if (role?.kind !== "sample" || styles.has(role.block)) {
        continue;
      }
      if (role.block === "image") {
        if (layer.type === "image") {
          const bounds = boundsOf(layer);
          styles.set("image", { type: "image", sample: layer, spaceBefore: role.spaceBefore, insetLeft: bounds.x - flow.x, width: bounds.width });
        }
        continue;
      }
      if (layer.type !== "text") {
        continue;
      }
      const sample = unscaledText(layer);
      const textWidth = sample.wrapWidth > 0 ? sample.wrapWidth : textNode(sample, sample.text, 100000).getTextWidth();
      const style: TextStyle = {
        type: "text",
        sample,
        spaceBefore: role.spaceBefore,
        insetLeft: Math.max(0, sample.x - flow.x),
        insetRight: Math.max(0, flow.x + flow.width - (sample.x + textWidth)),
      };
      const boxLayer = page.layers.find((candidate) =>
        candidate.type === "rect" && candidate.formatRole?.kind === "box" && candidate.formatRole.block === role.block);
      if (boxLayer?.type === "rect") {
        const box = boundsOf(boxLayer);
        const sampleHeight = textNode(sample, sample.text, textWidth).height();
        style.box = {
          layer: boxLayer,
          insetLeft: Math.max(0, box.x - flow.x),
          insetRight: Math.max(0, flow.x + flow.width - (box.x + box.width)),
          padTop: Math.max(0, sample.y - box.y),
          padBottom: Math.max(0, box.y + box.height - (sample.y + sampleHeight)),
        };
        // Text insets inside the box are measured from the box edges.
        style.insetLeft = Math.max(0, sample.x - box.x);
        style.insetRight = Math.max(0, box.x + box.width - (sample.x + textWidth));
      }
      styles.set(role.block, style);
    }
  }
  if (!styles.has("body")) {
    problems.push("No Body text sample: mark a text layer as \"Sample: Body text\".");
  }
  if (!styles.has("image")) {
    styles.set("image", { type: "image", sample: null, spaceBefore: 16, insetLeft: 0, width: null });
  }
  return { first, next, styles, problems };
}

function styleFor(info: FormatInfo, kind: BlockKind): BlockStyle | null {
  for (const candidate of [kind, ...FALLBACKS[kind]]) {
    const style = info.styles.get(candidate);
    if (style) {
      return style;
    }
  }
  return null;
}

/** The format's text layers (their fonts load before laying out). */
export function formatFonts(format: Design): TextLayer[] {
  return format.pages.flatMap((page) => page.layers.filter((layer): layer is TextLayer => layer.type === "text"));
}

/* ------------------------------------------------------------------------ */
/* Layout                                                                   */
/* ------------------------------------------------------------------------ */

export interface LayoutResult {
  pages: DesignPage[];
  /** Problems worth showing (missing samples, blocks too tall, missing images). */
  warnings: string[];
}

interface Placed {
  height: number;
  layers: (y: number) => Layer[];
}

/** Blocks that should not end a page: they introduce what follows. */
const KEEP_WITH_NEXT = new Set<BlockKind>(["title", "heading"]);

/** Text blocks that may continue on the next page. */
const SPLITTABLE = new Set<BlockKind>(["body", "callout", "lead"]);

function withoutRole(layer: Layer): Layer {
  const { formatRole: _role, ...rest } = layer;
  return rest;
}

/**
 * Lays content out with a format: pages from the first and following
 * masters, blocks stacked top-down in each flow area, breaking to a new
 * page when the next block doesn't fit. Long text continues on the next
 * page; a title or heading never ends a page.
 */
export async function layoutDocument(format: Design, items: ContentItem[]): Promise<LayoutResult> {
  await ensureFontsLoaded(formatFonts(format));
  const info = readFormat(format);
  const warnings = [...info.problems];

  // Image sizes up front, so the layout itself is synchronous.
  const imageSizes = new Map<string, { width: number; height: number }>();
  await Promise.all(items.map(async (item) => {
    if (item.kind === "image" && item.asset && !imageSizes.has(item.asset)) {
      try {
        imageSizes.set(item.asset, await loadAssetSize(item.asset));
      } catch {
        warnings.push(`Image not found in your uploads: ${item.asset}`);
      }
    }
  }));

  interface PageDraft {
    master: Master;
    content: Layer[];
    y: number;
    empty: boolean;
  }
  const drafts: PageDraft[] = [];
  const newPage = (): PageDraft => {
    const master = drafts.length === 0 ? info.first : info.next;
    const draft = { master, content: [], y: master.flow.y, empty: true };
    drafts.push(draft);
    return draft;
  };
  let page = newPage();

  /** Builds a text block for a flow area: its height and its layers at a given y. */
  const textBlock = (style: TextStyle, kind: BlockKind, text: string, flow: Box): Placed & { lines: { text: string; lastInParagraph: boolean }[]; lineHeight: number } => {
    const boxLeft = style.box ? flow.x + style.box.insetLeft : flow.x;
    const boxWidth = style.box ? flow.width - style.box.insetLeft - style.box.insetRight : flow.width;
    const width = Math.max(20, boxWidth - style.insetLeft - style.insetRight);
    const node = textNode(style.sample, text, width);
    const textHeight = node.height();
    const padTop = style.box?.padTop ?? 0;
    const padBottom = style.box?.padBottom ?? 0;
    const lines = node.textArr.map((line) => ({ text: line.text, lastInParagraph: line.lastInParagraph }));
    node.destroy();
    return {
      height: padTop + textHeight + padBottom,
      lineHeight: style.sample.fontSize * style.sample.lineHeight,
      lines,
      layers: (y) => {
        const layers: Layer[] = [];
        if (style.box) {
          layers.push(withoutRole({
            ...structuredClone(style.box.layer),
            id: newLayerId(),
            name: `${kind} box`,
            x: boxLeft,
            y,
            width: boxWidth,
            height: padTop + textHeight + padBottom,
            scaleX: 1,
            scaleY: 1,
            groupId: undefined,
          }));
        }
        layers.push(withoutRole({
          ...structuredClone(style.sample),
          id: newLayerId(),
          name: text.slice(0, 40),
          text,
          x: boxLeft + style.insetLeft,
          y: y + padTop,
          wrapWidth: width,
          groupId: undefined,
        }));
        return layers;
      },
    };
  };

  const imageBlock = (style: ImageStyle, block: ContentBlock, flow: Box): Placed | null => {
    const size = block.asset ? imageSizes.get(block.asset) : undefined;
    if (!block.asset || !size) {
      return null;
    }
    const left = Math.min(Math.max(0, style.insetLeft), flow.width - 20);
    let width = Math.min(style.width ?? flow.width, flow.width - left);
    let height = (width * size.height) / size.width;
    // Never taller than the flow area itself.
    if (height > flow.height) {
      width *= flow.height / height;
      height = flow.height;
    }
    const asset = block.asset;
    return {
      height,
      layers: (y) => {
        const base: ImageLayer = style.sample
          ? structuredClone(style.sample)
          : {
              id: "",
              type: "image",
              name: "",
              asset,
              x: 0,
              y: 0,
              width,
              height,
              scaleX: 1,
              scaleY: 1,
              rotation: 0,
              opacity: 1,
              visible: true,
              shadow: { enabled: false, color: "#000000", blur: 12, offsetX: 0, offsetY: 4, opacity: 0.8 },
            };
        return [withoutRole({
          ...base,
          id: newLayerId(),
          name: block.text || "Image",
          asset,
          crop: undefined,
          cutout: undefined,
          behindText: undefined,
          x: flow.x + left,
          y,
          width,
          height,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          groupId: undefined,
        })];
      },
    };
  };

  const measure = (block: ContentBlock, flow: Box) => {
    const style = styleFor(info, block.kind);
    if (!style) {
      return null;
    }
    if (style.type === "image") {
      return block.kind === "image" ? imageBlock(style, block, flow) : null;
    }
    return { ...textBlock(style, block.kind, block.text, flow), style };
  };

  const spaceBefore = (kind: BlockKind) => styleFor(info, kind)?.spaceBefore ?? 0;
  const bottom = (draft: PageDraft) => draft.master.flow.y + draft.master.flow.height;
  const place = (draft: PageDraft, placed: Placed, kind: BlockKind) => {
    const gap = draft.empty ? 0 : spaceBefore(kind);
    draft.content.push(...placed.layers(draft.y + gap));
    draft.y += gap + placed.height;
    draft.empty = false;
  };

  const blocks = items;
  for (let index = 0; index < blocks.length; index++) {
    const item = blocks[index];
    if (!item) {
      continue;
    }
    if (item.kind === "pageBreak") {
      if (!page.empty) {
        page = newPage();
      }
      continue;
    }
    if (item.kind !== "image" && !item.text) {
      continue;
    }
    let measured = measure(item, page.master.flow);
    if (!measured) {
      if (item.kind === "image" && item.asset && imageSizes.has(item.asset)) {
        warnings.push(`Couldn't place image ${item.asset}.`);
      }
      continue;
    }
    const gap = page.empty ? 0 : spaceBefore(item.kind);
    let needed = gap + measured.height;
    // Keep a title/heading with the start of what follows.
    const following = blocks[index + 1];
    if (KEEP_WITH_NEXT.has(item.kind) && following && following.kind !== "pageBreak") {
      const next = measure(following, page.master.flow);
      if (next) {
        const firstLine = "lineHeight" in next && SPLITTABLE.has(following.kind) ? Math.min(next.height, next.lineHeight * 2) : next.height;
        needed += spaceBefore(following.kind) + firstLine;
      }
    }

    if (page.y + needed > bottom(page) && !page.empty) {
      // Long text: fill this page with as many lines as fit, continue on the next.
      const room = bottom(page) - page.y - gap;
      if ("lines" in measured && SPLITTABLE.has(item.kind) && measured.lines.length > 1) {
        const style = measured.style;
        const padding = (style.box?.padTop ?? 0) + (style.box?.padBottom ?? 0);
        const fit = Math.floor((room - padding + 0.5) / measured.lineHeight);
        // Leave at least two lines on each side (no orphans or widows).
        if (fit >= 2 && measured.lines.length - fit >= 2) {
          const head = joinLines(measured.lines.slice(0, fit));
          const tail = joinLines(measured.lines.slice(fit));
          const headPlaced = measure({ ...item, text: head }, page.master.flow);
          if (headPlaced) {
            place(page, headPlaced, item.kind);
          }
          page = newPage();
          blocks.splice(index + 1, 0, { ...item, text: tail });
          continue;
        }
      }
      page = newPage();
      measured = measure(item, page.master.flow) ?? measured;
    }

    // Still taller than an empty page: split hard, or warn and let it overflow.
    if (page.empty && measured.height > page.master.flow.height && "lines" in measured && measured.lines.length > 1) {
      const style = measured.style;
      const padding = (style.box?.padTop ?? 0) + (style.box?.padBottom ?? 0);
      const fit = Math.max(1, Math.floor((page.master.flow.height - padding) / measured.lineHeight));
      if (fit < measured.lines.length) {
        const head = joinLines(measured.lines.slice(0, fit));
        const headPlaced = measure({ ...item, text: head }, page.master.flow);
        if (headPlaced) {
          place(page, headPlaced, item.kind);
        }
        page = newPage();
        blocks.splice(index + 1, 0, { ...item, text: joinLines(measured.lines.slice(fit)) });
        continue;
      }
    }
    if (measured.height > page.master.flow.height + 0.5) {
      warnings.push(`A ${item.kind} block is taller than a page and overflows: "${item.text.slice(0, 40)}…"`);
    }
    place(page, measured, item.kind);
  }

  const pages = drafts.map((draft, index): DesignPage => {
    const isLast = index === drafts.length - 1;
    const master = draft.master.page;
    const keep = (layer: Layer) => {
      const role = layer.formatRole?.kind;
      return role === undefined || (role === "hideOnLast" && !isLast);
    };
    const below = master.layers.slice(0, draft.master.flowIndex).filter(keep);
    const above = master.layers.slice(draft.master.flowIndex + 1).filter(keep);
    const decorations = clonePageContent({ ...master, layers: [...below, ...above] });
    const cleaned = decorations.layers.map(withoutRole);
    return {
      id: newLayerId(),
      background: master.background,
      backgroundGradient: structuredClone(master.backgroundGradient),
      layers: [...cleaned.slice(0, below.length), ...draft.content, ...cleaned.slice(below.length)],
    };
  });
  return { pages, warnings };
}

function joinLines(lines: { text: string; lastInParagraph: boolean }[]): string {
  return lines
    .map((line, index) => line.text + (index === lines.length - 1 ? "" : line.lastInParagraph ? "\n" : " "))
    .join("")
    .trim();
}
