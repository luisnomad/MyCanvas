import { type Hono } from "hono";

import type { AppEnv } from "./app";
import { publish } from "./events";
import { FONT_TYPES, FontError, MAX_FONT_BYTES, deleteFont, fontFaceCss, listFonts, readFontFile, saveFont } from "./fonts";

/**
 * Custom font routes under `prefix`: "/api/fonts/custom" for the editor,
 * "/api/agent/v1/fonts" for Claude. Same behaviour on both.
 */
export function registerFontRoutes(app: Hono<AppEnv>, prefix: string): void {
  app.get(prefix, async (c) => c.json(await listFonts(c.get("ws"))));

  /** Multipart: `file` (.ttf/.otf), optional `family` to override the font's own name. */
  app.post(prefix, async (c) => {
    const ws = c.get("ws");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Send multipart form data with a file field" }, 400);
    }
    if (file.size > MAX_FONT_BYTES) {
      return c.json({ error: "Font file too large (20 MB max)" }, 400);
    }
    const family = form?.get("family");
    try {
      const { font, replaced } = await saveFont(ws, Buffer.from(await file.arrayBuffer()), file.name, typeof family === "string" ? family : undefined);
      publish(ws, { type: "fonts.changed" });
      return c.json({ ...font, replaced }, 201);
    } catch (error) {
      if (error instanceof FontError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.delete(`${prefix}/:id`, async (c) => {
    const ws = c.get("ws");
    if (!await deleteFont(ws, c.req.param("id"))) {
      return c.json({ error: "Font not found" }, 404);
    }
    publish(ws, { type: "fonts.changed" });
    return c.json({ ok: true });
  });
}

/** The stylesheet and the font files themselves (caller's own workspace only). */
export function registerFontFiles(app: Hono<AppEnv>): void {
  app.get("/api/fonts/custom.css", async (c) => c.body(fontFaceCss(await listFonts(c.get("ws"))), 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "private, no-cache",
  }));

  app.get("/fonts/:file", async (c) => {
    const file = c.req.param("file");
    const bytes = await readFontFile(c.get("ws"), file);
    if (!bytes) {
      return c.notFound();
    }
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": FONT_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream",
      // File names are new for every upload, so a file never changes.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
  });
}
