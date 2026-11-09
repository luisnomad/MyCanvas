import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const serverRoot = path.resolve(import.meta.dirname, "..");

export const dataDir = process.env.MYCANVAS_DATA_DIR ?? path.join(serverRoot, "data");
/** One folder per signed-in person: data/users/<workspace key>/. */
export const usersDir = path.join(dataDir, "users");

/** Built web app, served by this server in production (see Dockerfile). */
export const webDistDir = process.env.MYCANVAS_WEB_DIST ?? path.resolve(serverRoot, "../web/dist");

export const fontDirs = [
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  "/Library/Fonts",
  path.join(homedir(), "Library/Fonts"),
];

/** A person's private designs, uploads, templates and settings. */
export interface Workspace {
  email: string;
  key: string;
  root: string;
  designsDir: string;
  assetsDir: string;
  templatesDir: string;
  assetsManifestFile: string;
  settingsFile: string;
  foldersFile: string;
}

/** Folder-safe, readable key for an email ("Luis.SG@gmail.com" → "luis-sg-gmail-com"). */
export function workspaceKey(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

function workspacePaths(email: string): Workspace {
  const key = workspaceKey(email);
  const root = path.join(usersDir, key);
  return {
    email,
    key,
    root,
    designsDir: path.join(root, "designs"),
    assetsDir: path.join(root, "assets"),
    templatesDir: path.join(root, "templates"),
    assetsManifestFile: path.join(root, "assets.json"),
    settingsFile: path.join(root, "settings.json"),
    foldersFile: path.join(root, "folders.json"),
  };
}

const ready = new Set<string>();

/** The workspace for `email`, creating its folders on first use. */
export async function workspaceFor(email: string): Promise<Workspace> {
  const workspace = workspacePaths(email);
  if (!ready.has(workspace.key)) {
    await mkdir(workspace.designsDir, { recursive: true });
    await mkdir(workspace.assetsDir, { recursive: true });
    await mkdir(workspace.templatesDir, { recursive: true });
    ready.add(workspace.key);
  }
  return workspace;
}

/**
 * Before workspaces, everything lived directly in the data dir. Move that
 * into the owner's workspace once, so the owner keeps all existing work and
 * nobody else ever sees it. Returns the entries it moved.
 */
export async function migrateLegacyDataIn(root: string, ownerEmail: string): Promise<string[]> {
  const ownerRoot = path.join(root, "users", workspaceKey(ownerEmail));
  const legacy = ["designs", "assets", "templates", "assets.json", "settings.json"]
    .filter((entry) => existsSync(path.join(root, entry)));
  if (legacy.length === 0) {
    return [];
  }
  await mkdir(ownerRoot, { recursive: true });
  const moved: string[] = [];
  for (const entry of legacy) {
    const target = path.join(ownerRoot, entry);
    if (existsSync(target)) {
      console.warn(`migration: ${target} already exists; leaving ${entry} in place`);
      continue;
    }
    await rename(path.join(root, entry), target);
    moved.push(entry);
  }
  if (moved.length > 0) {
    console.log(`migration: moved ${moved.join(", ")} into workspace ${workspaceKey(ownerEmail)}`);
  }
  return moved;
}

export async function migrateLegacyData(ownerEmail: string): Promise<void> {
  await migrateLegacyDataIn(dataDir, ownerEmail);
}

export function newId(): string {
  return randomBytes(8).toString("hex");
}

export function isSafeId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id);
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
