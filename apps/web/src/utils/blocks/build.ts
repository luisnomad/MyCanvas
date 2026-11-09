import { type BlockDesign, type BlockTheme, type DesignPage, type VisualPart } from "@mycanvas/shared";
import { ensureFontLoaded } from "../fonts";
import { type RepairedPart } from "./plan";
import { readSlots, renderPart } from "./render";

/*
 * Visual parts → pages: loads the theme's fonts and the pictures' sizes,
 * then draws every part on its own page.
 */

export async function loadImageSizes(assets: Iterable<string>): Promise<Map<string, { width: number; height: number }>> {
  const sizes = new Map<string, { width: number; height: number }>();
  await Promise.all([...new Set(assets)].map((asset) => new Promise<void>((resolve) => {
    const image = new Image();
    image.onload = () => {
      sizes.set(asset, { width: image.naturalWidth, height: image.naturalHeight });
      resolve();
    };
    image.onerror = () => {
      resolve();
    };
    image.src = `/assets/${encodeURIComponent(asset)}`;
  })));
  return sizes;
}

export async function loadThemeFonts(theme: BlockTheme): Promise<void> {
  await Promise.all([
    ensureFontLoaded(theme.fonts.heading.family, theme.fonts.heading.style),
    ensureFontLoaded(theme.fonts.body.family, theme.fonts.body.style),
    ensureFontLoaded(theme.fonts.body.family, "bold"),
  ]);
}

export interface DrawnPages {
  pages: DesignPage[];
  parts: VisualPart[];
  /** Pages whose text was too long even at the smallest size. */
  overflowing: number[];
}

/** Draws parts onto pages (existing page ids are kept so the editor follows along). */
export async function drawParts(
  parts: VisualPart[],
  theme: BlockTheme,
  width: number,
  height: number,
  /** Page numbers when only some pages are drawn (default: the parts' order). */
  numbering?: (part: VisualPart, index: number) => { pageNumber: number; pageCount: number },
): Promise<DrawnPages> {
  await loadThemeFonts(theme);
  const sizes = await loadImageSizes(parts.flatMap((part) => (part.slots.image ? [part.slots.image] : [])));
  const overflowing: number[] = [];
  // A picture that can't be loaded (deleted, or a name that never existed) leaves an empty frame to drop one into.
  parts = parts.map((part) => (part.slots.image && !sizes.has(part.slots.image) ? { ...part, slots: { ...part.slots, image: undefined } } : part));
  const pages = parts.map((part, index) => {
    const { pageNumber, pageCount } = numbering?.(part, index) ?? { pageNumber: index + 1, pageCount: parts.length };
    const drawn = renderPart({ part, theme, width, height, pageNumber, pageCount, imageSizes: sizes });
    if (drawn.overflow) {
      overflowing.push(pageNumber);
    }
    return { id: part.pageId, background: drawn.background, layers: drawn.layers };
  });
  return { pages, parts, overflowing };
}

export function partsFromPlan(plan: RepairedPart[]): VisualPart[] {
  return plan.map((part) => ({ id: crypto.randomUUID(), pageId: crypto.randomUUID(), block: part.block, variant: part.variant, slots: part.slots }));
}

/** Parts with the text and pictures people changed on the canvas read back in. */
export function partsWithEdits(blocks: BlockDesign, pages: DesignPage[]): VisualPart[] {
  return blocks.parts.map((part) => {
    const page = pages.find((entry) => entry.id === part.pageId);
    return page ? { ...part, slots: readSlots(part, page.layers) } : part;
  });
}
