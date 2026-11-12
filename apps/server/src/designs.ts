import path from "node:path";

import {
  type Design,
  type DesignPage,
  type DesignSummary,
  type DocumentSource,
  type Folder,
  type StoredDesign,
  ASPECT_RATIOS,
  cleanBlockDesign,
  normalizeDesign,
} from "@mycanvas/shared";

import { findStarterTemplate } from "./starter-templates";
import { type Workspace, isSafeId, newId, readJsonFile, writeJsonFile } from "./storage";

/** Reads a design or template file in the current (multi-page) shape. */
export async function readStored(file: string): Promise<Design | null> {
  const stored = await readJsonFile<StoredDesign>(file);
  return stored ? normalizeDesign(stored) : null;
}

export function designFile(ws: Workspace, id: string): string {
  return path.join(ws.designsDir, `${id}.json`);
}

export function toSummary(design: Design): DesignSummary {
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
    revision: design.revision ?? 0,
    createdAt: design.createdAt,
    updatedAt: design.updatedAt,
  };
}

export function isPageLike(page: unknown): page is DesignPage {
  const candidate = page as Partial<DesignPage> | null;
  return typeof candidate?.id === "string" && typeof candidate.background === "string" && Array.isArray(candidate.layers);
}

export function cleanSource(source: unknown): DocumentSource | undefined {
  const candidate = source as Partial<DocumentSource> | null | undefined;
  if (typeof candidate?.formatId !== "string" || typeof candidate.markdown !== "string") {
    return undefined;
  }
  return {
    formatId: candidate.formatId,
    formatName: typeof candidate.formatName === "string" ? candidate.formatName : "",
    markdown: candidate.markdown,
    generatedAt: typeof candidate.generatedAt === "string" ? candidate.generatedAt : new Date().toISOString(),
    ...(typeof candidate.formatUpdatedAt === "string" ? { formatUpdatedAt: candidate.formatUpdatedAt } : {}),
  };
}

export async function readFolders(ws: Workspace): Promise<Folder[]> {
  return (await readJsonFile<Folder[]>(ws.foldersFile)) ?? [];
}

/** The folder id to file a design under, or undefined when it doesn't exist. */
export async function existingFolderId(ws: Workspace, folderId: unknown): Promise<string | undefined> {
  if (typeof folderId !== "string") {
    return undefined;
  }
  return (await readFolders(ws)).some((folder) => folder.id === folderId) ? folderId : undefined;
}

export function cleanFolderName(name: unknown): string | null {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.length >= 1 && trimmed.length <= 80 ? trimmed : null;
}

export async function readDesign(ws: Workspace, id: string): Promise<Design | null> {
  if (!isSafeId(id)) {
    return null;
  }
  return readStored(designFile(ws, id));
}

/**
 * Stores a changed design as the next revision of `previous` (null for a
 * new design) and returns what was stored.
 */
export async function writeDesign(ws: Workspace, design: Design, previous: Design | null): Promise<Design> {
  const stored: Design = { ...design, revision: (previous?.revision ?? 0) + 1 };
  await writeJsonFile(designFile(ws, stored.id), stored);
  return stored;
}

export function templateFile(ws: Workspace, id: string): string {
  return path.join(ws.templatesDir, `${id}.json`);
}

/** Built-in starters first, then the person's own saved templates. */
export async function readTemplate(ws: Workspace, id: string): Promise<Design | null> {
  const starter = findStarterTemplate(id);
  if (starter) {
    return starter;
  }
  if (!isSafeId(id)) {
    return null;
  }
  return readStored(templateFile(ws, id));
}

export interface CreateDesignInput {
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
  blocks?: unknown;
}

export type CreateResult = { ok: true; design: Design } | { ok: false; status: 400 | 404; error: string };

/** A new design: blank, from a template, or from ready-made pages. */
export async function createDesign(ws: Workspace, body: CreateDesignInput): Promise<CreateResult> {
  const folderId = await existingFolderId(ws, body.folderId);
  const now = new Date().toISOString();
  const trimmedName = typeof body.name === "string" ? body.name.trim() : undefined;
  if (body.templateId !== undefined) {
    const source = await readTemplate(ws, body.templateId);
    if (!source) {
      return { ok: false, status: 404, error: "Template not found" };
    }
    const design: Design = {
      ...structuredClone(source),
      id: newId(),
      name: trimmedName === undefined || trimmedName === "" ? source.name : trimmedName,
      folderId,
      createdAt: now,
      updatedAt: now,
    };
    return { ok: true, design: await writeDesign(ws, design, null) };
  }
  const preset = ASPECT_RATIOS.find((r) => r.id === body.aspectRatioId) ?? ASPECT_RATIOS[0];
  const width = body.width ?? preset?.width ?? 1280;
  const height = body.height ?? preset?.height ?? 720;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0 || width > 8192 || height > 8192) {
    return { ok: false, status: 400, error: "Invalid canvas size" };
  }
  const pages = Array.isArray(body.pages) && body.pages.length > 0 ? body.pages : null;
  if (pages && !pages.every(isPageLike)) {
    return { ok: false, status: 400, error: "Invalid pages" };
  }
  const source = cleanSource(body.source);
  const blocks = cleanBlockDesign(body.blocks);
  const design: Design = {
    id: newId(),
    name: trimmedName === undefined || trimmedName === "" ? "Untitled design" : trimmedName,
    width,
    height,
    pages: pages ?? [{ id: newId(), background: typeof body.background === "string" ? body.background : "#ffffff", layers: [] }],
    folderId,
    ...(source ? { source } : {}),
    ...(blocks ? { blocks } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, design: await writeDesign(ws, design, null) };
}

/** A copy of a design (a variation), optionally renamed or filed elsewhere. */
export async function duplicateDesign(
  ws: Workspace,
  source: Design,
  options: { name?: string; folderId?: string | null } = {},
): Promise<Design> {
  const now = new Date().toISOString();
  const name = options.name?.trim();
  const folderId = options.folderId === undefined
    ? source.folderId
    : options.folderId === null ? undefined : await existingFolderId(ws, options.folderId);
  const copy: Design = {
    ...structuredClone(source),
    id: newId(),
    name: name === undefined || name === "" ? `${source.name} (copy)` : name,
    folderId,
    createdAt: now,
    updatedAt: now,
  };
  return writeDesign(ws, copy, null);
}
