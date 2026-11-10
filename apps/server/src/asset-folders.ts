import { type Folder } from "@mycanvas/shared";
import { type Hono } from "hono";
import { existsSync } from "node:fs";
import path from "node:path";
import { type Identity } from "./auth";
import { type Workspace, isSafeId, newId, readJsonFile, writeJsonFile } from "./storage";

/*
 * Folders for uploads, separate from design folders: a design is never a
 * folder. An upload is in at most one folder; uploads in none are "Unfiled".
 */

interface AssetFolders {
  folders: Folder[];
  /** Upload file name → folder id. */
  placed: Record<string, string>;
}

interface AppEnv { Variables: { ws: Workspace; identity: Identity } }

export async function readAssetFolders(ws: Workspace): Promise<AssetFolders> {
  const stored = await readJsonFile<Partial<AssetFolders>>(ws.assetFoldersFile);
  return { folders: stored?.folders ?? [], placed: stored?.placed ?? {} };
}

async function writeAssetFolders(ws: Workspace, data: AssetFolders): Promise<void> {
  await writeJsonFile(ws.assetFoldersFile, data);
}

/** Folder of each upload, leaving out folders that no longer exist. */
export async function assetFolderIndex(ws: Workspace): Promise<Map<string, string>> {
  const { folders, placed } = await readAssetFolders(ws);
  const ids = new Set(folders.map((folder) => folder.id));
  return new Map(Object.entries(placed).filter(([, folderId]) => ids.has(folderId)));
}

/** Files uploads into a folder (null: take them out of any folder). Unknown folder → false. */
export async function placeAssets(ws: Workspace, assets: string[], folderId: string | null): Promise<boolean> {
  const data = await readAssetFolders(ws);
  if (folderId !== null && !data.folders.some((folder) => folder.id === folderId)) {
    return false;
  }
  for (const asset of assets) {
    if (folderId === null) {
      delete data.placed[asset];
    } else {
      data.placed[asset] = folderId;
    }
  }
  await writeAssetFolders(ws, data);
  return true;
}

/** Forgets a deleted upload's folder. */
export async function forgetAsset(ws: Workspace, asset: string): Promise<void> {
  const data = await readAssetFolders(ws);
  if (asset in data.placed) {
    delete data.placed[asset];
    await writeAssetFolders(ws, data);
  }
}

function cleanName(name: unknown): string | null {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.length >= 1 && trimmed.length <= 80 ? trimmed : null;
}

function byName(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function registerAssetFolderRoutes(app: Hono<AppEnv>, isAssetFile: (file: string) => boolean): void {
  app.get("/api/asset-folders", async (c) => c.json(byName((await readAssetFolders(c.get("ws"))).folders)));

  app.post("/api/asset-folders", async (c) => {
    const ws = c.get("ws");
    const name = cleanName((await c.req.json<{ name?: unknown }>()).name);
    if (!name) {
      return c.json({ error: "Folder name must be 1–80 characters" }, 400);
    }
    const data = await readAssetFolders(ws);
    if (data.folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
      return c.json({ error: `A folder named "${name}" already exists` }, 409);
    }
    const folder: Folder = { id: newId(), name, createdAt: new Date().toISOString() };
    data.folders.push(folder);
    await writeAssetFolders(ws, data);
    return c.json(folder, 201);
  });

  app.patch("/api/asset-folders/:id", async (c) => {
    const ws = c.get("ws");
    const id = c.req.param("id");
    const name = cleanName((await c.req.json<{ name?: unknown }>()).name);
    if (!name) {
      return c.json({ error: "Folder name must be 1–80 characters" }, 400);
    }
    const data = await readAssetFolders(ws);
    const folder = data.folders.find((entry) => entry.id === id);
    if (!folder) {
      return c.json({ error: "Folder not found" }, 404);
    }
    if (data.folders.some((entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase())) {
      return c.json({ error: `A folder named "${name}" already exists` }, 409);
    }
    folder.name = name;
    await writeAssetFolders(ws, data);
    return c.json(folder);
  });

  /** Deletes a folder; its uploads are kept and become unfiled. */
  app.delete("/api/asset-folders/:id", async (c) => {
    const ws = c.get("ws");
    const id = c.req.param("id");
    const data = await readAssetFolders(ws);
    if (!data.folders.some((folder) => folder.id === id)) {
      return c.json({ error: "Folder not found" }, 404);
    }
    data.folders = data.folders.filter((folder) => folder.id !== id);
    data.placed = Object.fromEntries(Object.entries(data.placed).filter(([, folderId]) => folderId !== id));
    await writeAssetFolders(ws, data);
    return c.json({ ok: true });
  });

  /** Moves uploads into a folder, or out of any folder with `folderId: null`. */
  app.post("/api/assets/move", async (c) => {
    const ws = c.get("ws");
    const body = await c.req.json<{ assets?: unknown; folderId?: unknown }>();
    const assets = Array.isArray(body.assets) ? body.assets.filter((asset): asset is string => typeof asset === "string") : [];
    if (assets.length === 0 || assets.length > 2000) {
      return c.json({ error: "Choose 1–2000 uploads to move" }, 400);
    }
    if (!assets.every((asset) => isAssetFile(asset) && existsSync(path.join(ws.assetsDir, asset)))) {
      return c.json({ error: "Upload not found" }, 404);
    }
    const folderId = body.folderId === null || body.folderId === undefined ? null : typeof body.folderId === "string" && isSafeId(body.folderId) ? body.folderId : "";
    if (folderId === "" || !await placeAssets(ws, assets, folderId)) {
      return c.json({ error: "Folder not found" }, 404);
    }
    return c.json({ ok: true, moved: assets.length });
  });
}
