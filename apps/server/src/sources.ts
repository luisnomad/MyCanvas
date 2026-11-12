import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Workspace, isSafeId, newId, readJsonFile, writeJsonFile } from "./storage";

/*
 * Source files: PDFs, Word, PowerPoint and Markdown files that MyCanvas
 * reads content and style from (format from example, content import). They
 * are kept apart from Uploads, which only holds pictures to place.
 */

export const SOURCE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export interface SourceInfo {
  source: string;
  name: string;
  size: number;
  uploadedAt: string;
}

function sourcesDir(ws: Workspace): string {
  return path.join(ws.root, "sources");
}

function manifestFile(ws: Workspace): string {
  return path.join(ws.root, "sources.json");
}

export function isSafeSourceFile(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return ext in SOURCE_TYPES && isSafeId(path.basename(file, ext));
}

async function manifest(ws: Workspace): Promise<Record<string, string>> {
  return (await readJsonFile<Record<string, string>>(manifestFile(ws))) ?? {};
}

export async function saveSource(ws: Workspace, bytes: Buffer, ext: string, name: string): Promise<SourceInfo> {
  await mkdir(sourcesDir(ws), { recursive: true });
  const source = `${newId()}${ext}`;
  await writeFile(path.join(sourcesDir(ws), source), bytes);
  const names = await manifest(ws);
  names[source] = name;
  await writeJsonFile(manifestFile(ws), names);
  return { source, name, size: bytes.length, uploadedAt: new Date().toISOString() };
}

export async function listSources(ws: Workspace): Promise<SourceInfo[]> {
  const names = await manifest(ws);
  const infos = await Promise.all(Object.entries(names).map(async ([source, name]) => {
    try {
      const info = await stat(path.join(sourcesDir(ws), source));
      return { source, name, size: info.size, uploadedAt: info.mtime.toISOString() };
    } catch {
      return null;
    }
  }));
  return infos.filter((info): info is SourceInfo => info !== null).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** The file and its display name, or null. */
export async function readSource(ws: Workspace, source: string): Promise<{ bytes: Buffer; name: string } | null> {
  if (!isSafeSourceFile(source)) {
    return null;
  }
  try {
    const bytes = await readFile(path.join(sourcesDir(ws), source));
    return { bytes, name: (await manifest(ws))[source] ?? source };
  } catch {
    return null;
  }
}
