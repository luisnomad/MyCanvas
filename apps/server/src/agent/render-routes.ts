import path from "node:path";

import { type Context, type Hono } from "hono";
import { type Design, type DocumentSource } from "@mycanvas/shared";

import type { AppEnv } from "../app";
import { LOCAL_USER } from "../auth";
import { createDesign, designFile, readDesign, readStored, writeDesign } from "../designs";
import { publish } from "../events";
import { acquireLock, listLocks, serialized } from "../locks";
import { RendererUnavailable, runHeadless, setKeepWarm } from "../renderer";
import { MAX_SOURCE_BYTES, SOURCE_TYPES, isSafeSourceFile, listSources, readSource, saveSource } from "../sources";
import { type Workspace, workspaceFor, writeJsonFile } from "../storage";
import { storedZip } from "../zip";

/*
 * What needs the headless renderer (docs/AGENT_API.md): renders, layout
 * boxes, PDF/zip export, documents from Markdown, formats from an example
 * PDF and content import; plus fresh project-list previews after Claude's
 * writes.
 */

const BASE = "/api/agent/v1";

function agentLabel(c: Context): string {
  const label = c.req.header("x-mycanvas-agent")?.trim();
  return label !== undefined && label !== "" ? label.slice(0, 40) : "Claude";
}

function rendererOff(): boolean {
  return process.env.MYCANVAS_RENDERER === "off";
}

/** Renderer failures as JSON: 503 when Chromium itself isn't available. */
function rendererError(c: Context, error: unknown): Response {
  if (error instanceof RendererUnavailable) {
    return c.json({ error: `The renderer is unavailable: ${error.message}` }, 503);
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: message }, /not found|no page/i.test(message) ? 404 : 500);
}

function pageParam(c: Context): number | null {
  const raw = c.req.query("page") ?? "0";
  const page = Number(raw);
  return Number.isInteger(page) && page >= 0 ? page : null;
}

function scaleParam(c: Context, fallback: number): number | null {
  const raw = c.req.query("scale");
  const scale = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(scale) && scale >= 0.1 && scale <= 3 ? scale : null;
}

function safeFileName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._-]+/gu, "").trim().slice(0, 80) || "design";
}

function dataUrlBytes(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

// ------------------------------------------------------------- previews

const MAX_THUMBNAIL_PAGES = 12;
const THUMBNAIL_DELAY_MS = 3000;
const pendingThumbnails = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Refreshes the previews Claude's changes made stale (pages without one),
 * a few seconds after the last change. Stored without a new revision, so
 * an open editor's next save isn't refused for it.
 */
export function scheduleThumbnails(ws: Workspace, designId: string): void {
  if (rendererOff()) {
    return;
  }
  const key = `${ws.key}/${designId}`;
  const existing = pendingThumbnails.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    pendingThumbnails.delete(key);
    void refreshThumbnails(ws, designId).catch((error: unknown) => {
      console.warn(`thumbnails for ${designId}:`, error instanceof Error ? error.message : error);
    });
  }, THUMBNAIL_DELAY_MS);
  timer.unref();
  pendingThumbnails.set(key, timer);
}

async function refreshThumbnails(ws: Workspace, designId: string): Promise<void> {
  const design = await readDesign(ws, designId);
  if (!design) {
    return;
  }
  const missing = design.pages
    .map((page, index) => (page.thumbnail ? -1 : index))
    .filter((index) => index >= 0)
    .slice(0, MAX_THUMBNAIL_PAGES);
  if (missing.length === 0 && design.thumbnail) {
    return;
  }
  const indexes = missing.length > 0 ? missing : [0];
  const made = await runHeadless("thumbnails", designId, indexes);
  await serialized(ws, designId, async () => {
    const current = await readDesign(ws, designId);
    // Changed again meanwhile: the next scheduled refresh covers it.
    if (!current || (current.revision ?? 0) !== (design.revision ?? 0)) {
      return;
    }
    const pages = current.pages.map((page, index) => (made[index] ? { ...page, thumbnail: made[index] } : page));
    const updated: Design = { ...current, pages, thumbnail: pages[0]?.thumbnail ?? current.thumbnail };
    await writeJsonFile(designFile(ws, designId), updated);
    publish(ws, { type: "design.thumbnail", id: designId });
  });
}

// ------------------------------------------------------------- routes

export function registerRenderRoutes(app: Hono<AppEnv>): void {
  // The renderer stays warm while Claude holds any lock.
  setKeepWarm(async () => (await listLocks(await workspaceFor(LOCAL_USER))).some((lock) => lock.holder === "agent"));

  /** A page as PNG or JPEG. Missing fonts are listed in X-MyCanvas-Missing-Fonts. */
  app.get(`${BASE}/designs/:id/render`, async (c) => {
    const id = c.req.param("id");
    const page = pageParam(c);
    const scale = scaleParam(c, 1);
    const format = (c.req.query("format") ?? "png").toLowerCase();
    const quality = Number(c.req.query("quality") ?? "0.9");
    if (page === null || scale === null || !["png", "jpg", "jpeg"].includes(format) || !(quality > 0 && quality <= 1)) {
      return c.json({ error: "Use page=0…, scale=0.1–3, format=png|jpg, quality=0–1" }, 400);
    }
    if (!await readDesign(c.get("ws"), id)) {
      return c.json({ error: "Not found" }, 404);
    }
    try {
      const result = await runHeadless("renderPage", id, page, { format: format === "png" ? "png" : "jpeg", scale, quality });
      return c.body(new Uint8Array(dataUrlBytes(result.dataUrl)), 200, {
        "Content-Type": format === "png" ? "image/png" : "image/jpeg",
        "Cache-Control": "no-store",
        "X-MyCanvas-Missing-Fonts": result.missingFonts.map(encodeURIComponent).join(","),
      });
    } catch (error) {
      return rendererError(c, error);
    }
  });

  /** Each layer's rendered box on a page, and fonts the renderer lacked. */
  app.get(`${BASE}/designs/:id/layout`, async (c) => {
    const id = c.req.param("id");
    const page = pageParam(c);
    if (page === null) {
      return c.json({ error: "page must be 0 or more" }, 400);
    }
    if (!await readDesign(c.get("ws"), id)) {
      return c.json({ error: "Not found" }, 404);
    }
    try {
      return c.json(await runHeadless("layout", id, page));
    } catch (error) {
      return rendererError(c, error);
    }
  });

  app.get(`${BASE}/designs/:id/export.pdf`, async (c) => {
    const id = c.req.param("id");
    const scale = scaleParam(c, 2);
    const design = await readDesign(c.get("ws"), id);
    if (!design) {
      return c.json({ error: "Not found" }, 404);
    }
    if (scale === null) {
      return c.json({ error: "scale must be 0.1–3" }, 400);
    }
    try {
      const pdf = Buffer.from(await runHeadless("exportPdf", id, scale), "base64");
      return c.body(new Uint8Array(pdf), 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeFileName(design.name)}.pdf"`,
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return rendererError(c, error);
    }
  });

  /** Every page as PNG/JPEG in one zip. */
  app.get(`${BASE}/designs/:id/export.zip`, async (c) => {
    const id = c.req.param("id");
    const scale = scaleParam(c, 1);
    const format = (c.req.query("format") ?? "png").toLowerCase();
    const design = await readDesign(c.get("ws"), id);
    if (!design) {
      return c.json({ error: "Not found" }, 404);
    }
    if (scale === null || !["png", "jpg", "jpeg"].includes(format)) {
      return c.json({ error: "Use scale=0.1–3 and format=png|jpg" }, 400);
    }
    const ext = format === "png" ? "png" : "jpg";
    try {
      const files: { name: string; data: Buffer }[] = [];
      for (let index = 0; index < design.pages.length; index++) {
        const result = await runHeadless("renderPage", id, index, { format: ext === "png" ? "png" : "jpeg", scale, quality: 0.9 });
        files.push({ name: `${safeFileName(design.name)}-page-${String(index + 1)}.${ext}`, data: dataUrlBytes(result.dataUrl) });
      }
      return c.body(new Uint8Array(storedZip(files)), 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeFileName(design.name)}.zip"`,
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return rendererError(c, error);
    }
  });

  /** Formats (designs whose pages are masters for documents). */
  app.get(`${BASE}/formats`, async (c) => {
    const ws = c.get("ws");
    const { readdir } = await import("node:fs/promises");
    const formats = [];
    for (const file of await readdir(ws.designsDir).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const design = await readStored(path.join(ws.designsDir, file));
      if (design?.kind === "format") {
        formats.push({ id: design.id, name: design.name, width: design.width, height: design.height, pageCount: design.pages.length, folderId: design.folderId, updatedAt: design.updatedAt });
      }
    }
    return c.json(formats);
  });

  /** A document laid out from Markdown with a format (like "New document"). */
  app.post(`${BASE}/documents`, async (c) => {
    const ws = c.get("ws");
    const body = await c.req.json<{ formatId?: unknown; markdown?: unknown; name?: unknown; folderId?: unknown }>().catch(() => null);
    if (typeof body?.formatId !== "string" || typeof body.markdown !== "string" || body.markdown.trim() === "") {
      return c.json({ error: "Send { formatId, markdown, name?, folderId? }" }, 400);
    }
    if (!await readDesign(ws, body.formatId)) {
      return c.json({ error: "Format not found" }, 404);
    }
    let laidOut;
    try {
      laidOut = await runHeadless("layoutDocument", body.formatId, body.markdown);
    } catch (error) {
      return rendererError(c, error);
    }
    const source: DocumentSource = {
      formatId: laidOut.format.id,
      formatName: laidOut.format.name,
      markdown: body.markdown,
      generatedAt: new Date().toISOString(),
      formatUpdatedAt: laidOut.format.updatedAt,
    };
    const name = typeof body.name === "string" && body.name.trim() !== "" ? body.name : laidOut.title ?? `${laidOut.format.name} document`;
    const result = await createDesign(ws, {
      name,
      width: laidOut.format.width,
      height: laidOut.format.height,
      pages: laidOut.pages,
      source,
      folderId: typeof body.folderId === "string" ? body.folderId : undefined,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    await acquireLock(ws, result.design.id, "agent", agentLabel(c));
    publish(ws, { type: "design.created", id: result.design.id, folderId: result.design.folderId, by: "agent", clientId: null });
    scheduleThumbnails(ws, result.design.id);
    return c.json({ id: result.design.id, name: result.design.name, pageCount: result.design.pages.length, revision: result.design.revision, warnings: laidOut.warnings }, 201);
  });

  /** Uploads a source file (PDF, DOCX, PPTX, Markdown) to read content or style from. */
  app.post(`${BASE}/sources`, async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Send multipart form data with a file field" }, 400);
    }
    const ext = path.extname(file.name).toLowerCase();
    if (!(ext in SOURCE_TYPES)) {
      return c.json({ error: `Unsupported source type: ${ext || "(none)"} (pdf, docx, pptx, md, txt)` }, 400);
    }
    if (file.size > MAX_SOURCE_BYTES) {
      return c.json({ error: "File too large (50 MB max)" }, 400);
    }
    return c.json(await saveSource(c.get("ws"), Buffer.from(await file.arrayBuffer()), ext, file.name), 201);
  });

  app.get(`${BASE}/sources`, async (c) => c.json(await listSources(c.get("ws"))));

  /** A format learned from an example PDF: page size, art, fonts, colours, spacing. */
  app.post(`${BASE}/formats/from-example`, async (c) => {
    const ws = c.get("ws");
    const body = await c.req.json<{ source?: unknown; name?: unknown; folderId?: unknown; describe?: unknown }>().catch(() => null);
    if (typeof body?.source !== "string") {
      return c.json({ error: "Send { source, name?, folderId?, describe? } (source: from POST /sources)" }, 400);
    }
    const source = await readSource(ws, body.source);
    if (!source) {
      return c.json({ error: "Source not found" }, 404);
    }
    if (!body.source.toLowerCase().endsWith(".pdf")) {
      return c.json({ error: "Formats are learned from PDFs" }, 400);
    }
    const name = typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : source.name.replace(/\.[^.]+$/, "");
    let built;
    try {
      built = await runHeadless("formatFromExample", `/api/sources/${body.source}`, source.name, name, body.describe === true);
    } catch (error) {
      return rendererError(c, error);
    }
    const result = await createDesign(ws, {
      name,
      width: built.width,
      height: built.height,
      pages: built.pages,
      folderId: typeof body.folderId === "string" ? body.folderId : undefined,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    const format = await writeDesign(ws, { ...result.design, kind: "format", ...(built.formatAi ? { formatAi: built.formatAi } : {}) }, result.design);
    await acquireLock(ws, format.id, "agent", agentLabel(c));
    publish(ws, { type: "design.created", id: format.id, folderId: format.folderId, by: "agent", clientId: null });
    publish(ws, { type: "assets.changed" });
    scheduleThumbnails(ws, format.id);
    return c.json({ id: format.id, name: format.name, width: format.width, height: format.height, pageCount: format.pages.length, roles: built.roles, warnings: built.warnings }, 201);
  });

  /** A source file's content as the editor's Markdown dialect (images go to Uploads). */
  app.post(`${BASE}/content/import`, async (c) => {
    const ws = c.get("ws");
    const body = await c.req.json<{ source?: unknown; pagePerPage?: unknown }>().catch(() => null);
    if (typeof body?.source !== "string") {
      return c.json({ error: "Send { source, pagePerPage? } (source: from POST /sources)" }, 400);
    }
    const source = await readSource(ws, body.source);
    if (!source) {
      return c.json({ error: "Source not found" }, 404);
    }
    try {
      const imported = await runHeadless("importContent", `/api/sources/${body.source}`, source.name, body.pagePerPage === true);
      publish(ws, { type: "assets.changed" });
      return c.json(imported);
    } catch (error) {
      return rendererError(c, error);
    }
  });
}

/** Source files, read by the renderer page (owner access, like uploads). */
export function registerSourceFileRoute(app: Hono<AppEnv>): void {
  app.get("/api/sources/:file", async (c) => {
    const file = c.req.param("file");
    if (!isSafeSourceFile(file)) {
      return c.json({ error: "Not found" }, 404);
    }
    const source = await readSource(c.get("ws"), file);
    if (!source) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.body(new Uint8Array(source.bytes), 200, {
      "Content-Type": SOURCE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });
}
