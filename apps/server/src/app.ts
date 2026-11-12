import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type AssetInfo,
  type Design,
  type DesignSummary,
  type Folder,
  type TemplateSummary,
  cleanBlockDesign,
  isGeneratedAssetName,
  GOOGLE_FONTS,
} from "@mycanvas/shared";

import { isOwner } from "./ai/network";
import { registerAiRoutes } from "./ai/routes";
import { assetFolderIndex, forgetAsset, placeAssets, registerAssetFolderRoutes } from "./asset-folders";
import { assetUsageIndex } from "./asset-usage";
import { readAssetManifest, saveAsset } from "./assets-store";
import { registerAgentRoutes } from "./agent/routes";
import { type Identity, identify } from "./auth";
import {
  type CreateDesignInput,
  cleanFolderName,
  cleanSource,
  createDesign,
  designFile,
  duplicateDesign,
  existingFolderId,
  readDesign,
  readFolders,
  readStored,
  templateFile,
  toSummary,
  writeDesign,
} from "./designs";
import { clientIdOf, eventStream, publish } from "./events";
import { dropLock, getLock, listLocks, releaseLock, serialized, takeOver, acquireLock } from "./locks";
import { STARTER_TEMPLATES, findStarterTemplate } from "./starter-templates";
import { listSystemFonts } from "./system-fonts";
import {
  type Workspace,
  dataDir,
  isSafeId,
  newId,
  readJsonFile,
  webDistDir,
  workspaceFor,
  writeJsonFile,
} from "./storage";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

interface FavoritesSettings {
  googleFontFavorites: string[];
}

async function readFavorites(ws: Workspace): Promise<FavoritesSettings> {
  return (await readJsonFile<FavoritesSettings>(ws.settingsFile)) ?? { googleFontFavorites: [] };
}

export interface AppEnv { Variables: { ws: Workspace; identity: Identity } }

export const app = new Hono<AppEnv>();

app.use("/api/*", cors());

// Every API call and image belongs to the caller's own workspace; nothing
// is shared between people (see auth.ts for how the caller is identified).
for (const pattern of ["/api/*", "/assets/*"]) {
  app.use(pattern, async (c, next) => {
    const result = await identify(c.req.raw.headers);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    c.set("identity", result.identity);
    c.set("ws", await workspaceFor(result.identity.email));
    await next();
  });
}

app.get("/api/me", (c) => {
  const identity = c.get("identity");
  return c.json({
    email: identity.email,
    via: identity.via,
    // Cloudflare Access ends the session at this path on the app's host.
    logoutUrl: identity.via === "access" ? "/cdn-cgi/access/logout" : null,
    isOwner: isOwner(identity.email),
  });
});

app.get("/api/designs", async (c) => {
  const ws = c.get("ws");
  let files: string[];
  try {
    files = await readdir(ws.designsDir);
  } catch {
    return c.json([]);
  }
  const summaries: DesignSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const design = await readStored(path.join(ws.designsDir, file));
    if (design) {
      summaries.push(toSummary(design));
    }
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json(summaries);
});

app.post("/api/designs", async (c) => {
  const ws = c.get("ws");
  const result = await createDesign(ws, await c.req.json<CreateDesignInput>());
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  publish(ws, { type: "design.created", id: result.design.id, folderId: result.design.folderId, by: "human", clientId: clientIdOf(c) });
  return c.json(result.design, 201);
});

app.get("/api/designs/:id", async (c) => {
  const design = await readDesign(c.get("ws"), c.req.param("id"));
  if (!design) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(design);
});

app.put("/api/designs/:id", async (c) => {
  const ws = c.get("ws");
  const id = c.req.param("id");
  const body = await c.req.json<Partial<Design> & { baseRevision?: unknown }>();
  return serialized(ws, id, async () => {
    const existing = await readDesign(ws, id);
    if (!existing) {
      return c.json({ error: "Not found" }, 404);
    }
    // Claude is editing: the editor is view-only until Luis takes over.
    const lock = await getLock(ws, id);
    if (lock?.holder === "agent") {
      return c.json({ error: "locked", lock }, 423);
    }
    // Saved from an older copy than the stored one: refuse instead of
    // overwriting newer changes. (Editors from before revisions send none.)
    if (typeof body.baseRevision === "number" && body.baseRevision < (existing.revision ?? 0)) {
      return c.json({ error: "stale", revision: existing.revision ?? 0 }, 409);
    }
    // An editor save may change these fields only. Identity, folder and dates
    // stay server-owned; an empty or missing page list would lose content, so
    // the stored pages are kept in that case.
    const design: Design = {
      ...existing,
      name: typeof body.name === "string" ? body.name : existing.name,
      width: typeof body.width === "number" ? body.width : existing.width,
      height: typeof body.height === "number" ? body.height : existing.height,
      thumbnail: typeof body.thumbnail === "string" ? body.thumbnail : existing.thumbnail,
      pages: Array.isArray(body.pages) && body.pages.length > 0 ? body.pages : existing.pages,
      updatedAt: new Date().toISOString(),
    };
    // Optional fields: present in the body = set (null clears), absent = keep.
    if ("kind" in body) {
      if (body.kind === "format") {
        design.kind = "format";
      } else {
        delete design.kind;
      }
    }
    if ("formatAi" in body) {
      const ai = body.formatAi as Partial<Record<"contentRules" | "illustrationStyle", unknown>> | undefined;
      const text = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 4000) : "");
      const contentRules = text(ai?.contentRules);
      const illustrationStyle = text(ai?.illustrationStyle);
      if (contentRules || illustrationStyle) {
        design.formatAi = { contentRules, illustrationStyle };
      } else {
        delete design.formatAi;
      }
    }
    if ("source" in body) {
      const source = cleanSource(body.source);
      if (source) {
        design.source = source;
      } else {
        delete design.source;
      }
    }
    if ("blocks" in body) {
      const blocks = cleanBlockDesign(body.blocks);
      if (blocks) {
        design.blocks = blocks;
      } else {
        delete design.blocks;
      }
    }
    const stored = await writeDesign(ws, design, existing);
    publish(ws, { type: "design.updated", id, revision: stored.revision ?? 0, by: "human", clientId: clientIdOf(c) });
    return c.json(stored);
  });
});

app.delete("/api/designs/:id", async (c) => {
  const id = c.req.param("id");
  if (!isSafeId(id)) {
    return c.json({ error: "Not found" }, 404);
  }
  try {
    await unlink(designFile(c.get("ws"), id));
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  await dropLock(c.get("ws"), id);
  publish(c.get("ws"), { type: "design.deleted", id, by: "human", clientId: clientIdOf(c) });
  return c.json({ ok: true });
});

app.post("/api/designs/:id/duplicate", async (c) => {
  const ws = c.get("ws");
  const source = await readDesign(ws, c.req.param("id"));
  if (!source) {
    return c.json({ error: "Not found" }, 404);
  }
  const copy = await duplicateDesign(ws, source);
  publish(ws, { type: "design.created", id: copy.id, folderId: copy.folderId, by: "human", clientId: clientIdOf(c) });
  return c.json(copy, 201);
});

app.post("/api/designs/:id/move", async (c) => {
  const ws = c.get("ws");
  const design = await readDesign(ws, c.req.param("id"));
  if (!design) {
    return c.json({ error: "Not found" }, 404);
  }
  const body = await c.req.json<{ folderId?: string | null }>();
  const folderId = body.folderId === null || body.folderId === undefined
    ? undefined
    : await existingFolderId(ws, body.folderId);
  if (body.folderId && !folderId) {
    return c.json({ error: "Folder not found" }, 404);
  }
  const moved = await writeDesign(ws, { ...design, folderId }, design);
  publish(ws, { type: "design.updated", id: moved.id, revision: moved.revision ?? 0, by: "human", clientId: clientIdOf(c) });
  return c.json(toSummary(moved));
});

/** Live updates for every open tab (see events.ts). */
app.get("/api/events", (c) => eventStream(c, c.get("ws")));

/** Every locked design, for the lock badges in the project list. */
app.get("/api/locks", async (c) => c.json(await listLocks(c.get("ws"))));

app.get("/api/designs/:id/lock", async (c) => c.json(await getLock(c.get("ws"), c.req.param("id"))));

/** Luis's first edit locks the design to him (423 while Claude has it). */
app.post("/api/designs/:id/lock", async (c) => {
  const ws = c.get("ws");
  const id = c.req.param("id");
  if (!await readDesign(ws, id)) {
    return c.json({ error: "Not found" }, 404);
  }
  const result = await acquireLock(ws, id, "human", c.get("identity").email);
  return result.ok ? c.json(result.lock) : c.json({ error: "locked", lock: result.lock }, 423);
});

/** Luis takes the design back from Claude, at once. */
app.post("/api/designs/:id/lock/takeover", async (c) => {
  const ws = c.get("ws");
  const id = c.req.param("id");
  if (!await readDesign(ws, id)) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(await takeOver(ws, id, c.get("identity").email));
});

/** Unlock: releases Luis's own lock (Claude's is taken over, not released). */
app.delete("/api/designs/:id/lock", async (c) => {
  const released = await releaseLock(c.get("ws"), c.req.param("id"), "human");
  return c.json({ ok: true, released });
});

app.get("/api/folders", async (c) => {
  const folders = await readFolders(c.get("ws"));
  return c.json(folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
});

app.post("/api/folders", async (c) => {
  const ws = c.get("ws");
  const name = cleanFolderName((await c.req.json<{ name?: unknown }>()).name);
  if (!name) {
    return c.json({ error: "Folder name must be 1–80 characters" }, 400);
  }
  const folders = await readFolders(ws);
  if (folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: `A folder named "${name}" already exists` }, 409);
  }
  const folder: Folder = { id: newId(), name, createdAt: new Date().toISOString() };
  await writeJsonFile(ws.foldersFile, [...folders, folder]);
  return c.json(folder, 201);
});

app.patch("/api/folders/:id", async (c) => {
  const ws = c.get("ws");
  const id = c.req.param("id");
  const name = cleanFolderName((await c.req.json<{ name?: unknown }>()).name);
  if (!name) {
    return c.json({ error: "Folder name must be 1–80 characters" }, 400);
  }
  const folders = await readFolders(ws);
  const folder = folders.find((entry) => entry.id === id);
  if (!folder) {
    return c.json({ error: "Not found" }, 404);
  }
  if (folders.some((entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: `A folder named "${name}" already exists` }, 409);
  }
  folder.name = name;
  await writeJsonFile(ws.foldersFile, folders);
  return c.json(folder);
});

/** Deletes a folder; its designs are kept and become unfiled. */
app.delete("/api/folders/:id", async (c) => {
  const ws = c.get("ws");
  const id = c.req.param("id");
  const folders = await readFolders(ws);
  if (!folders.some((folder) => folder.id === id)) {
    return c.json({ error: "Not found" }, 404);
  }
  let unfiled = 0;
  for (const file of await readdir(ws.designsDir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const design = await readStored(path.join(ws.designsDir, file));
    if (design?.folderId === id) {
      await writeDesign(ws, { ...design, folderId: undefined }, design);
      unfiled += 1;
    }
  }
  await writeJsonFile(ws.foldersFile, folders.filter((folder) => folder.id !== id));
  return c.json({ ok: true, unfiled });
});

app.get("/api/templates", async (c) => {
  const ws = c.get("ws");
  const toTemplateSummary = (design: Design, builtIn: boolean): TemplateSummary =>
    ({ ...toSummary(design), builtIn });
  const user: TemplateSummary[] = [];
  let files: string[] = [];
  try {
    files = await readdir(ws.templatesDir);
  } catch {
    // No templates saved yet.
  }
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const design = await readStored(path.join(ws.templatesDir, file));
    if (design) {
      user.push(toTemplateSummary(design, false));
    }
  }
  user.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json([...user, ...STARTER_TEMPLATES.map((design) => toTemplateSummary(design, true))]);
});

app.post("/api/templates", async (c) => {
  const ws = c.get("ws");
  const body = await c.req.json<{ designId?: string; name?: string; thumbnail?: string }>();
  const source = body.designId === undefined ? null : await readDesign(ws, body.designId);
  if (!source) {
    return c.json({ error: "Design not found" }, 404);
  }
  const now = new Date().toISOString();
  const trimmed = body.name?.trim();
  // A fresh preview from the editor beats a possibly stale stored one.
  const thumbnail = body.thumbnail?.startsWith("data:image/") ? body.thumbnail : source.thumbnail;
  const saved: Design = {
    ...source,
    id: newId(),
    folderId: undefined,
    thumbnail,
    name: trimmed === undefined || trimmed === "" ? source.name : trimmed,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFile(templateFile(ws, saved.id), saved);
  return c.json({ ...toSummary(saved), builtIn: false } satisfies TemplateSummary, 201);
});

app.delete("/api/templates/:id", async (c) => {
  const id = c.req.param("id");
  if (findStarterTemplate(id)) {
    return c.json({ error: "Built-in templates can't be deleted" }, 400);
  }
  if (!isSafeId(id)) {
    return c.json({ error: "Not found" }, 404);
  }
  try {
    await unlink(templateFile(c.get("ws"), id));
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ ok: true });
});

function isSafeAssetFile(file: string): boolean {
  return isSafeId(path.basename(file, path.extname(file))) && path.extname(file).toLowerCase() in IMAGE_TYPES;
}

/** The person's upload library, newest first, with where each image is used. */
async function listAssets(c: Context<AppEnv>): Promise<Response> {
  const ws = c.get("ws");
  let files: string[];
  try {
    files = (await readdir(ws.assetsDir)).filter((file) => !file.startsWith("."));
  } catch {
    return c.json([]);
  }
  const [manifest, usage, placed] = await Promise.all([readAssetManifest(ws), assetUsageIndex(ws), assetFolderIndex(ws)]);
  const infos = await Promise.all(files.map(async (asset): Promise<AssetInfo | null> => {
    try {
      const info = await stat(path.join(ws.assetsDir, asset));
      const name = manifest[asset] ?? asset;
      return {
        asset,
        name,
        size: info.size,
        uploadedAt: info.mtime.toISOString(),
        generated: isGeneratedAssetName(name),
        usedIn: usage.get(asset) ?? [],
        folderId: placed.get(asset),
      };
    } catch {
      return null;
    }
  }));
  return c.json(
    infos
      .filter((info): info is AssetInfo => info !== null)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
  );
}

app.get("/api/assets", listAssets);

app.post("/api/assets", async (c) => {
  const ws = c.get("ws");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "File too large (25 MB max)" }, 400);
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!(ext in IMAGE_TYPES)) {
    return c.json({ error: `Unsupported file type: ${ext || "(none)"}` }, 400);
  }
  const asset = await saveAsset(ws, Buffer.from(await file.arrayBuffer()), ext, file.name);
  // Uploaded while a folder was open: file it there (an unknown folder leaves it unfiled).
  const folderId = form.get("folderId");
  if (typeof folderId === "string" && isSafeId(folderId)) {
    await placeAssets(ws, [asset], folderId);
  }
  publish(ws, { type: "assets.changed" });
  return c.json({ asset, name: file.name }, 201);
});

app.patch("/api/assets/:file", async (c) => {
  const ws = c.get("ws");
  const file = c.req.param("file");
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!isSafeAssetFile(file) || !existsSync(path.join(ws.assetsDir, file))) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!name || name.length > 200) {
    return c.json({ error: "Name must be 1–200 characters" }, 400);
  }
  const manifest = await readAssetManifest(ws);
  manifest[file] = name;
  await writeJsonFile(ws.assetsManifestFile, manifest);
  publish(ws, { type: "assets.changed" });
  return c.json({ asset: file, name });
});

/**
 * Deletes an upload. An image still used by a design or template is kept
 * (409 + where it's used) unless `?force=1`; forced deletes leave those
 * layers pointing at a missing image.
 */
app.delete("/api/assets/:file", async (c) => {
  const ws = c.get("ws");
  const file = c.req.param("file");
  if (!isSafeAssetFile(file)) {
    return c.json({ error: "Not found" }, 404);
  }
  if (c.req.query("force") !== "1") {
    const usedIn = (await assetUsageIndex(ws)).get(file) ?? [];
    if (usedIn.length > 0) {
      return c.json({ error: "Image is in use", usedIn }, 409);
    }
  }
  try {
    await unlink(path.join(ws.assetsDir, file));
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  const manifest = await readAssetManifest(ws);
  if (file in manifest) {
    delete manifest[file];
    await writeJsonFile(ws.assetsManifestFile, manifest);
  }
  await forgetAsset(ws, file);
  publish(ws, { type: "assets.changed" });
  return c.json({ ok: true });
});

/** Uploaded images, served only from the caller's own workspace. */
app.get("/assets/:file", async (c) => {
  const file = c.req.param("file");
  if (!isSafeAssetFile(file)) {
    return c.notFound();
  }
  try {
    const bytes = await readFile(path.join(c.get("ws").assetsDir, file));
    return c.body(bytes, 200, {
      "Content-Type": IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      // Per-person content: never cache in shared caches (Cloudflare edge).
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
  } catch {
    return c.notFound();
  }
});

app.get("/api/fonts/system", async (c) => {
  return c.json(await listSystemFonts());
});

const googleFamilies = new Set(GOOGLE_FONTS.map((font) => font.family));
const fontCacheDir = path.join(dataDir, "font-cache");

const weightCache = new Map<string, Promise<number[]>>();

/**
 * Upright weights a Google font family has. Google answers 400 for a weight
 * the family lacks (without CORS headers, so browsers can't probe it
 * quietly). Cached per family for the server's lifetime.
 */
app.get("/api/fonts/weights", async (c) => {
  const family = c.req.query("family") ?? "";
  if (!googleFamilies.has(family)) {
    return c.json({ error: "Not a Google font" }, 404);
  }
  let probe = weightCache.get(family);
  if (!probe) {
    probe = Promise.all([100, 200, 300, 400, 500, 600, 700, 800, 900].map(async (weight) => {
      try {
        const res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${String(weight)}`, {
          headers: { "User-Agent": "MyCanvas font check" },
        });
        return res.ok ? weight : null;
      } catch {
        return null;
      }
    })).then((weights) => weights.filter((weight): weight is number => weight !== null));
    weightCache.set(family, probe);
  }
  const weights = await probe;
  if (weights.length === 0) {
    // Offline or blocked: don't cache a wrong answer.
    weightCache.delete(family);
  }
  return c.json({ weights });
});

/**
 * A Google Font as a TrueType file, for embedding real text in PDF exports.
 * Only families from the curated list; files are public, so the cache is
 * shared by every workspace.
 */
app.get("/api/fonts/file", async (c) => {
  const family = c.req.query("family") ?? "";
  const requested = Number(c.req.query("weight") ?? "400");
  const weight = Number.isInteger(requested) && requested >= 100 && requested <= 900 && requested % 100 === 0 ? requested : 400;
  const italic = c.req.query("italic") === "1" ? 1 : 0;
  if (!googleFamilies.has(family)) {
    return c.json({ error: "Not a Google font" }, 404);
  }
  const cacheFile = path.join(fontCacheDir, `${family.replace(/[^A-Za-z0-9]+/g, "_")}-${String(weight)}-${String(italic)}.ttf`);
  const headers = { "Content-Type": "font/ttf", "Cache-Control": "private, max-age=604800" };
  try {
    return c.body(await readFile(cacheFile), 200, headers);
  } catch {
    // Not cached yet.
  }
  // A plain user agent makes Google Fonts serve TTF (browsers get WOFF2).
  const css = await fetch(
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@${String(italic)},${String(weight)}`,
    { headers: { "User-Agent": "MyCanvas font embedding" } },
  );
  const url = css.ok ? /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(await css.text())?.[1] : undefined;
  if (!url) {
    // The family has no such weight/style.
    return c.json({ error: "Font style not available" }, 404);
  }
  const file = await fetch(url);
  if (!file.ok) {
    return c.json({ error: "Font download failed" }, 502);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  await mkdir(fontCacheDir, { recursive: true });
  await writeFile(cacheFile, bytes);
  return c.body(bytes, 200, headers);
});

app.get("/api/fonts/favorites", async (c) => {
  return c.json(await readFavorites(c.get("ws")));
});

app.put("/api/fonts/favorites", async (c) => {
  const body = await c.req.json<Partial<FavoritesSettings>>();
  const settings: FavoritesSettings = {
    googleFontFavorites: Array.isArray(body.googleFontFavorites) ? body.googleFontFavorites : [],
  };
  await writeJsonFile(c.get("ws").settingsFile, settings);
  return c.json(settings);
});

registerAiRoutes(app);
registerAssetFolderRoutes(app, isSafeAssetFile);
registerAgentRoutes(app, { isSafeAssetFile, listAssets });

app.get("/healthz", (c) => c.json({ ok: true }));

// In production the server also serves the built web app (hash-routed, so
// no SPA fallback is needed). In dev, Vite serves it and proxies /api here.
if (existsSync(webDistDir)) {
  app.use("/*", serveStatic({ root: webDistDir }));
}
