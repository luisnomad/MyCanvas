import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type AssetInfo,
  type Design,
  type DesignSummary,
  type TemplateSummary,
  ASPECT_RATIOS,
  GENERATED_ASSET_NAMES,
} from "@mycanvas/shared";

import { assetUsageIndex } from "./asset-usage";
import { STARTER_TEMPLATES, findStarterTemplate } from "./starter-templates";
import { listSystemFonts } from "./system-fonts";
import {
  assetsDir,
  assetsManifestFile,
  designsDir,
  ensureDataDirs,
  isSafeId,
  newId,
  readJsonFile,
  settingsFile,
  templatesDir,
  webDistDir,
  writeJsonFile,
} from "./storage";

const PORT = Number(process.env.PORT ?? 3001);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

interface FavoritesSettings {
  googleFontFavorites: string[];
}

function designFile(id: string): string {
  return path.join(designsDir, `${id}.json`);
}

function toSummary(design: Design): DesignSummary {
  return {
    id: design.id,
    name: design.name,
    width: design.width,
    height: design.height,
    thumbnail: design.thumbnail,
    createdAt: design.createdAt,
    updatedAt: design.updatedAt,
  };
}

async function readDesign(id: string): Promise<Design | null> {
  if (!isSafeId(id)) {
    return null;
  }
  return readJsonFile<Design>(designFile(id));
}

function templateFile(id: string): string {
  return path.join(templatesDir, `${id}.json`);
}

/** Built-in starters first, then user templates saved under data/templates. */
async function readTemplate(id: string): Promise<Design | null> {
  const starter = findStarterTemplate(id);
  if (starter) {
    return starter;
  }
  if (!isSafeId(id)) {
    return null;
  }
  return readJsonFile<Design>(templateFile(id));
}

async function readFavorites(): Promise<FavoritesSettings> {
  return (await readJsonFile<FavoritesSettings>(settingsFile)) ?? { googleFontFavorites: [] };
}

const app = new Hono();

app.use("/api/*", cors());

app.get("/api/designs", async (c) => {
  let files: string[];
  try {
    files = await readdir(designsDir);
  } catch {
    return c.json([]);
  }
  const summaries: DesignSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const design = await readJsonFile<Design>(path.join(designsDir, file));
    if (design) {
      summaries.push(toSummary(design));
    }
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json(summaries);
});

app.post("/api/designs", async (c) => {
  const body = await c.req.json<{
    name?: string;
    aspectRatioId?: string;
    width?: number;
    height?: number;
    background?: string;
    templateId?: string;
  }>();
  if (body.templateId !== undefined) {
    const source = await readTemplate(body.templateId);
    if (!source) {
      return c.json({ error: "Template not found" }, 404);
    }
    const now = new Date().toISOString();
    const trimmed = body.name?.trim();
    const design: Design = {
      ...structuredClone(source),
      id: newId(),
      name: trimmed === undefined || trimmed === "" ? source.name : trimmed,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonFile(designFile(design.id), design);
    return c.json(design, 201);
  }
  const preset = ASPECT_RATIOS.find((r) => r.id === body.aspectRatioId) ?? ASPECT_RATIOS[0];
  const width = body.width ?? preset?.width ?? 1280;
  const height = body.height ?? preset?.height ?? 720;
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
    return c.json({ error: "Invalid canvas size" }, 400);
  }
  const now = new Date().toISOString();
  const trimmedName = body.name?.trim();
  const design: Design = {
    id: newId(),
    name: trimmedName === undefined || trimmedName === "" ? "Untitled design" : trimmedName,
    width,
    height,
    background: body.background ?? "#ffffff",
    layers: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFile(designFile(design.id), design);
  return c.json(design, 201);
});

app.get("/api/designs/:id", async (c) => {
  const design = await readDesign(c.req.param("id"));
  if (!design) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(design);
});

app.put("/api/designs/:id", async (c) => {
  const existing = await readDesign(c.req.param("id"));
  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }
  const body = await c.req.json<Partial<Design>>();
  const design: Design = {
    ...existing,
    ...body,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(designFile(design.id), design);
  return c.json(design);
});

app.delete("/api/designs/:id", async (c) => {
  const id = c.req.param("id");
  if (!isSafeId(id)) {
    return c.json({ error: "Not found" }, 404);
  }
  try {
    await unlink(designFile(id));
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ ok: true });
});

app.post("/api/designs/:id/duplicate", async (c) => {
  const source = await readDesign(c.req.param("id"));
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
  await writeJsonFile(designFile(copy.id), copy);
  return c.json(copy, 201);
});

app.get("/api/templates", async (c) => {
  const toTemplateSummary = (design: Design, builtIn: boolean): TemplateSummary =>
    ({ ...toSummary(design), builtIn });
  const user: TemplateSummary[] = [];
  let files: string[] = [];
  try {
    files = await readdir(templatesDir);
  } catch {
    // No templates saved yet.
  }
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const design = await readJsonFile<Design>(path.join(templatesDir, file));
    if (design) {
      user.push(toTemplateSummary(design, false));
    }
  }
  user.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json([...user, ...STARTER_TEMPLATES.map((design) => toTemplateSummary(design, true))]);
});

app.post("/api/templates", async (c) => {
  const body = await c.req.json<{ designId?: string; name?: string; thumbnail?: string }>();
  const source = body.designId === undefined ? null : await readDesign(body.designId);
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
    thumbnail,
    name: trimmed === undefined || trimmed === "" ? source.name : trimmed,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFile(templateFile(saved.id), saved);
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
    await unlink(templateFile(id));
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ ok: true });
});

function isSafeAssetFile(file: string): boolean {
  return isSafeId(path.basename(file, path.extname(file))) && IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

async function readAssetManifest(): Promise<Record<string, string>> {
  return (await readJsonFile<Record<string, string>>(assetsManifestFile)) ?? {};
}

/** The shared library, newest first, with where each image is used. */
app.get("/api/assets", async (c) => {
  let files: string[];
  try {
    files = (await readdir(assetsDir)).filter((file) => !file.startsWith("."));
  } catch {
    return c.json([]);
  }
  const [manifest, usage] = await Promise.all([readAssetManifest(), assetUsageIndex()]);
  const infos = await Promise.all(files.map(async (asset): Promise<AssetInfo | null> => {
    try {
      const info = await stat(path.join(assetsDir, asset));
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
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "File too large (25 MB max)" }, 400);
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return c.json({ error: `Unsupported file type: ${ext || "(none)"}` }, 400);
  }
  const asset = `${newId()}${ext}`;
  await writeFile(path.join(assetsDir, asset), Buffer.from(await file.arrayBuffer()));
  const manifest = (await readJsonFile<Record<string, string>>(assetsManifestFile)) ?? {};
  manifest[asset] = file.name;
  await writeJsonFile(assetsManifestFile, manifest);
  return c.json({ asset, name: file.name }, 201);
});

app.patch("/api/assets/:file", async (c) => {
  const file = c.req.param("file");
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!isSafeAssetFile(file) || !existsSync(path.join(assetsDir, file))) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!name || name.length > 200) {
    return c.json({ error: "Name must be 1–200 characters" }, 400);
  }
  const manifest = await readAssetManifest();
  manifest[file] = name;
  await writeJsonFile(assetsManifestFile, manifest);
  return c.json({ asset: file, name });
});

/**
 * Deletes an upload. An image still used by a design or template is kept
 * (409 + where it's used) unless `?force=1`; forced deletes leave those
 * layers pointing at a missing image.
 */
app.delete("/api/assets/:file", async (c) => {
  const file = c.req.param("file");
  if (!isSafeAssetFile(file)) {
    return c.json({ error: "Not found" }, 404);
  }
  if (c.req.query("force") !== "1") {
    const usedIn = (await assetUsageIndex()).get(file) ?? [];
    if (usedIn.length > 0) {
      return c.json({ error: "Image is in use", usedIn }, 409);
    }
  }
  try {
    await unlink(path.join(assetsDir, file));
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  const manifest = await readAssetManifest();
  if (file in manifest) {
    delete manifest[file];
    await writeJsonFile(assetsManifestFile, manifest);
  }
  return c.json({ ok: true });
});

app.use("/assets/*", serveStatic({ root: assetsDir, rewriteRequestPath: (p) => p.replace(/^\/assets/, "") }));

app.get("/api/fonts/system", async (c) => {
  return c.json(await listSystemFonts());
});

app.get("/api/fonts/favorites", async (c) => {
  return c.json(await readFavorites());
});

app.put("/api/fonts/favorites", async (c) => {
  const body = await c.req.json<Partial<FavoritesSettings>>();
  const settings: FavoritesSettings = {
    googleFontFavorites: Array.isArray(body.googleFontFavorites) ? body.googleFontFavorites : [],
  };
  await writeJsonFile(settingsFile, settings);
  return c.json(settings);
});

app.get("/healthz", (c) => c.json({ ok: true }));

// In production the server also serves the built web app (hash-routed, so
// no SPA fallback is needed). In dev, Vite serves it and proxies /api here.
if (existsSync(webDistDir)) {
  app.use("/*", serveStatic({ root: webDistDir }));
}

await ensureDataDirs();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`mycanvas server listening on http://localhost:${info.port}`);
});

export { app };
