import { type Context, type Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Design, allLayers } from "@mycanvas/shared";
import { type AppEnv } from "./app";
import { readDesign } from "./designs";
import { eventStream, publish } from "./events";
import { fontFaceCss, isSafeFontFile, listFonts, readFontFile } from "./fonts";
import {
  type ShareRecord,
  PIN_PATTERN,
  accessKeyMatches,
  deleteShare,
  notePinResult,
  pinLockedOut,
  pinMatches,
  saveShare,
  shareByToken,
  shareForDesign,
  shareInfo,
} from "./shares";
import { type Workspace, isSafeId, webDistDir, workspaceFor } from "./storage";

/*
 * Share links (see shares.ts).
 *
 * Editor side, signed in like the rest of /api: GET/PUT/DELETE
 * /api/designs/:id/share.
 *
 * Viewer side, public, everything under /s/<token> so a single path can be
 * let through the sign-in in front of the public host:
 *   /s/<token>              the viewer page (the web app)
 *   /s/<token>/design       the design, read-only
 *   /s/<token>/unlock       POST { pin } → sets the viewer cookie
 *   /s/<token>/events       live updates for this design only
 *   /s/<token>/assets/<f>   images the design uses
 *   /s/<token>/fonts.json, fonts.css, fonts/<f>   uploaded fonts
 * The cookie (path /s/<token>) carries the link's access key, so images,
 * fonts and the event stream work without anything in the URL.
 */

const COOKIE = "mycanvas_share";

interface ShareRouteDeps {
  isSafeAssetFile: (file: string) => boolean;
  imageTypes: Record<string, string>;
}

function withoutThumbnails(design: Design): Design {
  const { thumbnail: _thumbnail, ...rest } = design;
  return { ...rest, pages: design.pages.map(({ thumbnail: _pageThumbnail, ...page }) => page) };
}

/** Image files the design draws (photos, frame contents, cutouts). */
export function designAssets(design: Design): Set<string> {
  const assets = new Set<string>();
  for (const layer of allLayers(design)) {
    if (layer.type === "image") {
      assets.add(layer.asset);
    } else if (layer.type === "frame" && layer.content) {
      assets.add(layer.content.asset);
    }
  }
  return assets;
}

const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

interface Viewer { record: ShareRecord; ws: Workspace; design: Design }

/**
 * The link's record, workspace and design when the caller may see them;
 * otherwise the response to send (404 unknown or stopped, 401 PIN needed).
 */
async function viewer(c: Context): Promise<Viewer | Response> {
  const record = await shareByToken(c.req.param("token") ?? "");
  if (!record) {
    return c.json({ error: "This link isn't shared any more" }, 404, noStore);
  }
  const ws = await workspaceFor(record.email);
  const design = await readDesign(ws, record.designId);
  if (!design) {
    return c.json({ error: "This link isn't shared any more" }, 404, noStore);
  }
  // The link alone is enough unless it has a PIN: then the cookie from /unlock.
  if (record.pin !== undefined && !accessKeyMatches(record, getCookie(c, COOKIE))) {
    return c.json({ error: "Enter the PIN to see this design", pin: true }, 401, noStore);
  }
  return { record, ws, design };
}

/** The request's JSON object, or {} when there is none. */
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function cookiePath(record: ShareRecord): string {
  return `/s/${record.token}`;
}

function isHttps(c: Context): boolean {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

function grantAccess(c: Context, record: ShareRecord): void {
  setCookie(c, COOKIE, record.accessKey, {
    path: cookiePath(record),
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(c),
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function registerShareRoutes(app: Hono<AppEnv>, deps: ShareRouteDeps): void {
  // ── Editor side ──────────────────────────────────────────────────────
  app.get("/api/designs/:id/share", async (c) => {
    const id = c.req.param("id");
    if (!isSafeId(id) || !await readDesign(c.get("ws"), id)) {
      return c.json({ error: "Not found" }, 404);
    }
    const record = await shareForDesign(c.get("ws").email, id);
    return c.json({ share: record ? shareInfo(record) : null, publicUrl: process.env.MYCANVAS_PUBLIC_URL ?? null });
  });

  app.put("/api/designs/:id/share", async (c) => {
    const ws = c.get("ws");
    const id = c.req.param("id");
    if (!isSafeId(id) || !await readDesign(ws, id)) {
      return c.json({ error: "Not found" }, 404);
    }
    const body = await jsonBody(c);
    const pin = body.pin;
    if (pin !== undefined && pin !== null && (typeof pin !== "string" || !PIN_PATTERN.test(pin))) {
      return c.json({ error: "The PIN is 4 to 8 digits" }, 400);
    }
    const record = await saveShare(ws.email, id, {
      ...(pin === undefined ? {} : { pin }),
      newLink: body.newLink === true,
    });
    publish(ws, { type: "share.changed", id });
    return c.json({ share: shareInfo(record), publicUrl: process.env.MYCANVAS_PUBLIC_URL ?? null });
  });

  app.delete("/api/designs/:id/share", async (c) => {
    const ws = c.get("ws");
    const id = c.req.param("id");
    await deleteShare(ws.email, id);
    publish(ws, { type: "share.changed", id });
    return c.json({ share: null });
  });

  // ── Viewer side (public) ─────────────────────────────────────────────
  app.get("/s/:token/design", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    return c.json({ design: withoutThumbnails(found.design) }, 200, noStore);
  });

  app.post("/s/:token/unlock", async (c) => {
    const record = await shareByToken(c.req.param("token"));
    if (!record) {
      return c.json({ error: "This link isn't shared any more" }, 404, noStore);
    }
    if (pinLockedOut(record.token)) {
      return c.json({ error: "Too many wrong PINs. Try again in a few minutes." }, 429, noStore);
    }
    const body = await jsonBody(c);
    const pin = typeof body.pin === "string" ? body.pin.trim() : "";
    const ok = await pinMatches(record, pin);
    notePinResult(record.token, ok);
    if (!ok) {
      return c.json({ error: "That PIN isn't right" }, 401, noStore);
    }
    grantAccess(c, record);
    return c.json({ ok: true }, 200, noStore);
  });

  app.get("/s/:token/events", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    const id = found.record.designId;
    return eventStream(c, found.ws, (event) =>
      ((event.type === "design.updated" || event.type === "design.deleted" || event.type === "share.changed") && event.id === id) ||
      event.type === "fonts.changed");
  });

  app.get("/s/:token/assets/:file", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    const file = c.req.param("file");
    // Only what this design draws, never the rest of the workspace.
    if (!deps.isSafeAssetFile(file) || !designAssets(found.design).has(file)) {
      return c.notFound();
    }
    try {
      const bytes = await readFile(path.join(found.ws.assetsDir, file));
      return c.body(bytes, 200, {
        "Content-Type": deps.imageTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      });
    } catch {
      return c.notFound();
    }
  });

  app.get("/s/:token/fonts.json", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    return c.json(await listFonts(found.ws), 200, noStore);
  });

  app.get("/s/:token/fonts.css", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    return c.body(fontFaceCss(await listFonts(found.ws), `/s/${found.record.token}/fonts/`), 200, {
      "Content-Type": "text/css; charset=utf-8",
      ...noStore,
    });
  });

  app.get("/s/:token/fonts/:file", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    const file = c.req.param("file");
    const bytes = isSafeFontFile(file) ? await readFontFile(found.ws, file) : null;
    if (!bytes) {
      return c.notFound();
    }
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": file.endsWith(".otf") ? "font/otf" : "font/ttf",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  // The viewer page itself: the built web app, which shows the design alone
  // for /s/<token> paths. (In dev, Vite serves it.)
  app.get("/s/:token", async (c) => {
    try {
      const html = await readFile(path.join(webDistDir, "index.html"), "utf8");
      return c.html(html, 200, noStore);
    } catch {
      return c.notFound();
    }
  });
}
