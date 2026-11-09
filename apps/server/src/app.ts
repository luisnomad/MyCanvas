import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type AssetInfo,
  type Design,
  type DesignPage,
  type DesignSummary,
  type DocumentSource,
  type Folder,
  type StoredDesign,
  type TemplateSummary,
  ASPECT_RATIOS,
  GENERATED_ASSET_NAMES,
  GOOGLE_FONTS,
  normalizeDesign,
} from "@mycanvas/shared";

import { assetUsageIndex } from "./asset-usage";
import { type Identity, identify } from "./auth";
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

/** Reads a design or template file in the current (multi-page) shape. */
async function readStored(file: string): Promise<Design | null> {
  const stored = await readJsonFile<StoredDesign>(file);
  return stored ? normalizeDesign(stored) : null;
}

function designFile(ws: Workspace, id: string): string {
  return path.join(ws.designsDir, `${id}.json`);
}

function toSummary(design: Design): DesignSummary {
  return {
    id: design.id,
    name: design.name,
    width: design.width,
    height: design.height,
    pageCount: design.pages.length,
    thumbnail: design.thumbnail,
    folderId: design.folderId,
    kind: design.kind,
    sourceFormat: design.source?.formatName,
    createdAt: design.createdAt,
    updatedAt: design.updatedAt,
  };
}

function isPageLike(page: unknown): page is DesignPage {
  const candidate = page as Partial<DesignPage> | null;
  return typeof candidate?.id === "string" && typeof candidate.background === "string" && Array.isArray(candidate.layers);
}

function cleanSource(source: unknown): DocumentSource | undefined {
  const candidate = source as Partial<DocumentSource> | null | undefined;
  if (typeof candidate?.formatId !== "string" || typeof candidate.markdown !== "string") {
    return undefined;
  }
  return {
    formatId: candidate.formatId,
    formatName: typeof candidate.formatName === "string" ? candidate.formatName : "",
    markdown: candidate.markdown,
    generatedAt: typeof candidate.generatedAt === "string" ? candidate.generatedAt : new Date().toISOString(),
  };
}

async function readFolders(ws: Workspace): Promise<Folder[]> {
  return (await readJsonFile<Folder[]>(ws.foldersFile)) ?? [];
}

/** The folder id to file a design under, or undefined when it doesn't exist. */
async function existingFolderId(ws: Workspace, folderId: unknown): Promise<string | undefined> {
  if (typeof folderId !== "string") {
    return undefined;
  }
  return (await readFolders(ws)).some((folder) => folder.id === folderId) ? folderId : undefined;
}

function cleanFolderName(name: unknown): string | null {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.length >= 1 && trimmed.length <= 80 ? trimmed : null;
}

async function readDesign(ws: Workspace, id: string): Promise<Design | null> {
  if (!isSafeId(id)) {
    return null;
  }
  return readStored(designFile(ws, id));
}

function templateFile(ws: Workspace, id: string): string {
  return path.join(ws.templatesDir, `${id}.json`);
}

/** Built-in starters first, then the person's own saved templates. */
async function readTemplate(ws: Workspace, id: string): Promise<Design | null> {
  const starter = findStarterTemplate(id);
  if (starter) {
    return starter;
  }
  if (!isSafeId(id)) {
    return null;
  }
  return readStored(templateFile(ws, id));
}

async function readFavorites(ws: Workspace): Promise<FavoritesSettings> {
  return (await readJsonFile<FavoritesSettings>(ws.settingsFile)) ?? { googleFontFavorites: [] };
}

export const app = new Hono<{ Variables: { ws: Workspace; identity: Identity } }>();

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
  const body = await c.req.json<{
    name?: string;
    aspectRatioId?: string;
    width?: number;
    height?: number;
    background?: string;
    templateId?: string;
    folderId?: string;
    /** Ready-made pages, e.g. a document generated from a format. */
    pages?: DesignPage[];
    source?: DocumentSource;
  }>();
  const folderId = await existingFolderId(ws, body.folderId);
  if (body.templateId !== undefined) {
    const source = await readTemplate(ws, body.templateId);
    if (!source) {
      return c.json({ error: "Template not found" }, 404);
    }
    const now = new Date().toISOString();
    const trimmed = body.name?.trim();
    const design: Design = {
      ...structuredClone(source),
      id: newId(),
      name: trimmed === undefined || trimmed === "" ? source.name : trimmed,
      folderId,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonFile(designFile(ws, design.id), design);
    return c.json(design, 201);
  }
  const preset = ASPECT_RATIOS.find((r) => r.id === body.aspectRatioId) ?? ASPECT_RATIOS[0];
  const width = body.width ?? preset?.width ?? 1280;
  const height = body.height ?? preset?.height ?? 720;
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
    return c.json({ error: "Invalid canvas size" }, 400);
  }
  const pages = Array.isArray(body.pages) && body.pages.length > 0 ? body.pages : null;
  if (pages && !pages.every(isPageLike)) {
    return c.json({ error: "Invalid pages" }, 400);
  }
  const source = cleanSource(body.source);
  const now = new Date().toISOString();
  const trimmedName = body.name?.trim();
  const design: Design = {
    id: newId(),
    name: trimmedName === undefined || trimmedName === "" ? "Untitled design" : trimmedName,
    width,
    height,
    pages: pages ?? [{ id: newId(), background: body.background ?? "#ffffff", layers: [] }],
    folderId,
    ...(source ? { source } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFile(designFile(ws, design.id), design);
  return c.json(design, 201);
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
  const existing = await readDesign(ws, c.req.param("id"));
  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }
  const body = await c.req.json<Partial<Design>>();
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
  if ("source" in body) {
    const source = cleanSource(body.source);
    if (source) {
      design.source = source;
    } else {
      delete design.source;
    }
  }
  await writeJsonFile(designFile(ws, design.id), design);
  return c.json(design);
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
  return c.json({ ok: true });
});

app.post("/api/designs/:id/duplicate", async (c) => {
  const ws = c.get("ws");
  const source = await readDesign(ws, c.req.param("id"));
  if (!source) {
    return c.json({ error: "Not found" }, 404);
  }
  const now = new Date().toISOString();
  const copy: Design = {
    ...source,
    id: newId(),
    name: `${source.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFile(designFile(ws, copy.id), copy);
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
  const moved: Design = { ...design, folderId };
  await writeJsonFile(designFile(ws, design.id), moved);
  return c.json(toSummary(moved));
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
      await writeJsonFile(path.join(ws.designsDir, file), { ...design, folderId: undefined });
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

async function readAssetManifest(ws: Workspace): Promise<Record<string, string>> {
  return (await readJsonFile<Record<string, string>>(ws.assetsManifestFile)) ?? {};
}

/** The person's upload library, newest first, with where each image is used. */
app.get("/api/assets", async (c) => {
  const ws = c.get("ws");
  let files: string[];
  try {
    files = (await readdir(ws.assetsDir)).filter((file) => !file.startsWith("."));
  } catch {
    return c.json([]);
  }
  const [manifest, usage] = await Promise.all([readAssetManifest(ws), assetUsageIndex(ws)]);
  const infos = await Promise.all(files.map(async (asset): Promise<AssetInfo | null> => {
    try {
      const info = await stat(path.join(ws.assetsDir, asset));
      const name = manifest[asset] ?? asset;
      return {
        asset,
        name,
        size: info.size,
        uploadedAt: info.mtime.toISOString(),
        generated: GENERATED_ASSET_NAMES.includes(name),
        usedIn: usage.get(asset) ?? [],
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
});

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
  const asset = `${newId()}${ext}`;
  await writeFile(path.join(ws.assetsDir, asset), Buffer.from(await file.arrayBuffer()));
  const manifest = await readAssetManifest(ws);
  manifest[asset] = file.name;
  await writeJsonFile(ws.assetsManifestFile, manifest);
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

app.get("/healthz", (c) => c.json({ ok: true }));

// In production the server also serves the built web app (hash-routed, so
// no SPA fallback is needed). In dev, Vite serves it and proxies /api here.
if (existsSync(webDistDir)) {
  app.use("/*", serveStatic({ root: webDistDir }));
}
