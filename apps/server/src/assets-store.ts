import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type Workspace, newId, readJsonFile, writeJsonFile } from "./storage";

/** Upload file name → display name. */
export async function readAssetManifest(ws: Workspace): Promise<Record<string, string>> {
  return (await readJsonFile<Record<string, string>>(ws.assetsManifestFile)) ?? {};
}

/** Stores an image in the person's library; returns its file name (served at /assets/<name>). */
export async function saveAsset(ws: Workspace, bytes: Buffer, extension: string, displayName: string): Promise<string> {
  const asset = `${newId()}${extension}`;
  await writeFile(path.join(ws.assetsDir, asset), bytes);
  const manifest = await readAssetManifest(ws);
  manifest[asset] = displayName;
  await writeJsonFile(ws.assetsManifestFile, manifest);
  return asset;
}
