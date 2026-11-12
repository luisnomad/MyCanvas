import { useEffect } from "react";
import { type Design, type DesignPage, type Layer, type TextLayer } from "@mycanvas/shared";
import { api } from "../api";
import { CanvasStage } from "../components/CanvasStage";
import { setHeadlessMode, useEditorStore } from "../store/editorStore";
import { loadCustomFonts } from "../utils/custom-fonts";
import { exportDesignImage, getContentLayer, getLayerNode, makeDesignThumbnail } from "../utils/canvas-bridge";

/*
 * The server's renderer (docs/AGENT_API.md, "The headless renderer"): a
 * headless Chromium opens #/headless and calls window.mycanvasHeadless.
 * It draws with the editor's own canvas code, so renders match what Luis
 * sees, and it never saves or locks anything.
 */

export interface RenderOptions {
  format: "png" | "jpeg";
  /** Output size multiplier, 0.25–3 (as in the export dialog). */
  scale: number;
  /** JPEG quality, 0–1. */
  quality: number;
}

export interface LayerBox {
  id: string;
  name: string;
  type: Layer["type"];
  x: number;
  y: number;
  width: number;
  height: number;
  /** Partly or fully outside the page. */
  outside: boolean;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => { resolve(); });
  });
}

/** Opens a design (fresh from the server) on the given page and waits until it is drawn. */
async function openPage(designId: string, pageIndex: number): Promise<DesignPage> {
  // Fonts uploaded since the last job.
  await loadCustomFonts();
  const store = useEditorStore.getState();
  await store.loadDesign(designId);
  const state = useEditorStore.getState();
  if (state.loadStatus !== "ready" || !state.design) {
    throw new Error(state.loadStatus === "not-found" ? "Design not found" : "Design failed to load");
  }
  const page = state.design.pages[pageIndex];
  if (!page) {
    throw new Error(`No page ${String(pageIndex)} (the design has ${String(state.design.pages.length)})`);
  }
  state.setActivePage(page.id);
  // The canvas mounts once a design is loaded; wait for its bridge.
  for (let tries = 0; tries < 100 && !getContentLayer(); tries++) {
    await nextFrame();
  }
  const { waitForPage } = await import("../utils/pdf-export");
  await waitForPage(useEditorStore.getState().design?.layers ?? []);
  return page;
}

/** Fonts the page asks for that this browser doesn't have (they'd fall back to another font). */
function missingFonts(layers: Layer[]): string[] {
  const families = [...new Set(layers.filter((layer): layer is TextLayer => layer.type === "text").map((layer) => layer.fontFamily))];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return [];
  }
  const sample = "MyCanvas Wg 0123 áéñ";
  const width = (font: string) => {
    ctx.font = font;
    return ctx.measureText(sample).width;
  };
  return families.filter((family) =>
    ["monospace", "serif", "sans-serif"].every((fallback) => width(`40px "${family}", ${fallback}`) === width(`40px ${fallback}`)));
}

function layerBoxes(designWidth: number, designHeight: number): LayerBox[] {
  const layers = useEditorStore.getState().design?.layers ?? [];
  const content = getContentLayer();
  return layers.flatMap((layer) => {
    const node = getLayerNode(layer.id);
    if (!node || !content) {
      return [];
    }
    const box = node.getClientRect({ relativeTo: content });
    const outside = box.x < -0.5 || box.y < -0.5 || box.x + box.width > designWidth + 0.5 || box.y + box.height > designHeight + 0.5;
    return [{
      id: layer.id,
      name: layer.name,
      type: layer.type,
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
      outside,
    }];
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fileFromUrl(url: string, name: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Couldn't read ${name} (HTTP ${String(res.status)})`);
  }
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type });
}

const headlessApi = {
  /** One page as an image (data URL), plus fonts it lacked. */
  async renderPage(designId: string, pageIndex: number, options: RenderOptions) {
    await openPage(designId, pageIndex);
    const design = useEditorStore.getState().design as Design & { background: string };
    const dataUrl = exportDesignImage({
      mimeType: options.format === "png" ? "image/png" : "image/jpeg",
      quality: options.quality,
      pixelRatio: options.scale,
      flattenWhite: options.format === "jpeg" && design.background === "transparent",
    });
    return { dataUrl, missingFonts: missingFonts(design.pages[pageIndex]?.layers ?? []) };
  },

  /** Each layer's rendered box on a page (text bounds, overflow checks). */
  async layout(designId: string, pageIndex: number) {
    await openPage(designId, pageIndex);
    const design = useEditorStore.getState().design;
    if (!design) {
      throw new Error("Design failed to load");
    }
    return { width: design.width, height: design.height, layers: layerBoxes(design.width, design.height), missingFonts: missingFonts(design.layers) };
  },

  /** Small previews for the project list: page index → JPEG data URL. */
  async thumbnails(designId: string, pageIndexes: number[]) {
    const result: Record<number, string> = {};
    for (const index of pageIndexes) {
      await openPage(designId, index);
      const thumbnail = makeDesignThumbnail();
      if (thumbnail) {
        result[index] = thumbnail;
      }
    }
    return result;
  },

  /** Every page as a PDF (the editor's own PDF export), base64. */
  async exportPdf(designId: string, scale: number) {
    await openPage(designId, 0);
    const { exportDesignPdf } = await import("../utils/pdf-export");
    return base64(await exportDesignPdf({ pixelRatio: scale }));
  },

  /** Lays Markdown out with a format, like "New document". */
  async layoutDocument(formatId: string, markdown: string) {
    await loadCustomFonts();
    const { layoutDocument, parseContent } = await import("../utils/document-format");
    const format = await api.getDesign(formatId);
    if (format.kind !== "format") {
      throw new Error(`"${format.name}" is not a format`);
    }
    const items = parseContent(markdown);
    const result = await layoutDocument(format, items);
    const title = items.find((item) => item.kind === "title");
    return {
      pages: result.pages,
      warnings: result.warnings,
      format: { id: format.id, name: format.name, width: format.width, height: format.height, updatedAt: format.updatedAt },
      title: title && "text" in title ? title.text.replace(/\n/g, " ") : null,
    };
  },

  /** Content of a PDF, DOCX, PPTX or Markdown file as Markdown (images go to Uploads). */
  async importContent(sourceUrl: string, fileName: string, pagePerSourcePage: boolean) {
    const { importContentFile } = await import("../utils/import");
    const file = await fileFromUrl(sourceUrl, fileName);
    return importContentFile(
      file,
      async (blob, imageName) => (await api.uploadAsset(new File([blob], imageName, { type: blob.type }))).asset,
      { pagePerSourcePage },
    );
  },

  /** A format learned from an example PDF (its style); the server stores it. */
  async formatFromExample(sourceUrl: string, fileName: string, name: string, describe: boolean) {
    const file = await fileFromUrl(sourceUrl, fileName);
    const { analyzePdf } = await import("../utils/format-from-example/analyze-pdf");
    const { buildFormat } = await import("../utils/format-from-example/build-format");
    const analysis = await analyzePdf(file, 2);
    if (analysis.pages.every((page) => page.blocks.length === 0)) {
      throw new Error("This PDF has no real text (it's scanned, or its text was turned into pictures), so there's nothing to learn fonts and styles from.");
    }
    const result = await buildFormat(analysis.pages, name, () => undefined);
    const warnings = [...result.warnings];
    let formatAi;
    if (describe) {
      try {
        const { describeExample } = await import("../utils/format-from-example/describe");
        formatAi = await describeExample(analysis.pages);
      } catch (reason) {
        warnings.push(`AI instructions weren't written: ${reason instanceof Error ? reason.message : "the model failed"}.`);
      }
    }
    return { width: result.width, height: result.height, pages: result.pages, roles: result.roles, warnings, formatAi };
  },
};

export type HeadlessApi = typeof headlessApi;

declare global {
  interface Window {
    mycanvasHeadless?: HeadlessApi;
  }
}

export function Headless() {
  const design = useEditorStore((state) => state.design);

  useEffect(() => {
    setHeadlessMode(true);
    window.mycanvasHeadless = headlessApi;
    document.documentElement.dataset.headlessReady = "1";
    return () => {
      delete window.mycanvasHeadless;
      setHeadlessMode(false);
    };
  }, []);

  if (!design) {
    return null;
  }
  return (
    <div style={{ width: design.width, height: design.height, position: "relative", overflow: "hidden" }}>
      <CanvasStage design={design} scale={1} onFitScale={() => undefined} />
    </div>
  );
}
