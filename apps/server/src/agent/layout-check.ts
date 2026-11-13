import { type Design } from "@mycanvas/shared";
import { runHeadless } from "../renderer";

/*
 * After a batch of ops, the agent gets told straight away when a layer it
 * just added or changed ended up off the page, or a font it asked for isn't
 * there, instead of having to remember to call /layout and look.
 */

export interface LayoutBox {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  outside: boolean;
}

export interface PageLayout {
  width: number;
  height: number;
  layers: LayoutBox[];
  missingFonts: string[];
}

export interface LayoutWarning {
  page: number;
  layer?: string;
  problem: "off_page" | "partly_off_page" | "missing_font";
  message: string;
  /** The layer's drawn box on the page (it can differ from its x/y, e.g. curved text). */
  box?: { x: number; y: number; width: number; height: number };
}

export type LayoutCheck =
  | { checked: true; warnings: LayoutWarning[] }
  | { checked: false; reason: string };

const CHECK_TIMEOUT_MS = 20_000;

/** Warnings for the touched layers of one laid-out page; `fonts` are the touched text's families. */
export function layoutWarnings(layout: PageLayout, page: number, touched: Set<string>, fonts: Set<string>): LayoutWarning[] {
  const warnings: LayoutWarning[] = [];
  for (const layer of layout.layers) {
    if (!touched.has(layer.id) || !layer.outside) {
      continue;
    }
    const box = { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
    const off = box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= layout.width || box.y >= layout.height;
    const where = `drawn at ${String(box.x)},${String(box.y)} (${String(box.width)}×${String(box.height)}) on a ${String(layout.width)}×${String(layout.height)} page`;
    warnings.push(off
      ? { page, layer: layer.id, problem: "off_page", message: `"${layer.id}" is entirely off the page: ${where}`, box }
      : { page, layer: layer.id, problem: "partly_off_page", message: `"${layer.id}" is partly off the page (fine if it is meant to bleed): ${where}`, box });
  }
  for (const family of layout.missingFonts.filter((name) => fonts.has(name))) {
    warnings.push({ page, problem: "missing_font", message: `The font "${family}" isn't available, so text using it falls back to another font. Upload it (POST /fonts) or pick another.` });
  }
  return warnings;
}

/** The pages (by index) holding these layers. */
export function pagesOf(design: Design, ids: Iterable<string>): number[] {
  const wanted = new Set(ids);
  return design.pages.flatMap((page, index) => (page.layers.some((layer) => wanted.has(layer.id)) ? [index] : []));
}

/** Lays out each page the batch touched and collects warnings for the touched layers. */
export async function checkLayout(design: Design, touched: Set<string>): Promise<LayoutCheck> {
  if (process.env.MYCANVAS_RENDERER === "off") {
    return { checked: false, reason: "the renderer is off" };
  }
  const pages = pagesOf(design, touched);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`took longer than ${String(CHECK_TIMEOUT_MS / 1000)} s; call /layout to check`));
    }, CHECK_TIMEOUT_MS);
  });
  try {
    const warnings: LayoutWarning[] = [];
    for (const page of pages) {
      const layout = await Promise.race([runHeadless("layout", design.id, page), timeout]);
      const fonts = new Set((design.pages[page]?.layers ?? []).flatMap((layer) => (layer.type === "text" && touched.has(layer.id) ? [layer.fontFamily] : [])));
      warnings.push(...layoutWarnings(layout, page, touched, fonts));
    }
    return { checked: true, warnings };
  } catch (error) {
    return { checked: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
