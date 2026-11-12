import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { type CustomFont } from "@mycanvas/shared";
import { type Workspace, isSafeId, newId, readJsonFile, writeJsonFile } from "./storage";

/*
 * Custom fonts (docs/AGENT_API.md, "Fonts"): font files uploaded into a
 * workspace, offered in the font picker, drawn on the canvas and embedded
 * in PDF exports. One file per face; faces with the same family name form
 * one family.
 */

export const FONT_TYPES: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
export const MAX_FONT_BYTES = 20 * 1024 * 1024;

export class FontError extends Error {}

function fontsDir(ws: Workspace): string {
  return path.join(ws.root, "fonts");
}

function manifestFile(ws: Workspace): string {
  return path.join(ws.root, "fonts.json");
}

export function isSafeFontFile(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return ext in FONT_TYPES && isSafeId(path.basename(file, ext));
}

export async function listFonts(ws: Workspace): Promise<CustomFont[]> {
  const fonts = (await readJsonFile<CustomFont[]>(manifestFile(ws))) ?? [];
  return [...fonts].sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || Number(a.italic) - Number(b.italic));
}

interface ParsedFace {
  family: string;
  weight: number;
  italic: boolean;
  variable: boolean;
}

/** Shape of the parts of a fontkit font this reads (its typings are partial). */
interface FontkitFace {
  familyName: string | null;
  subfamilyName: string | null;
  getName?: (key: string) => string | null;
  variationAxes?: Record<string, unknown>;
  fonts?: unknown[];
  numGlyphs?: number;
}

/** Reads family, weight and style from the font's own tables. */
export function parseFont(bytes: Buffer): ParsedFace {
  let face: FontkitFace;
  try {
    face = fontkit.create(new Uint8Array(bytes));
  } catch {
    throw new FontError("This file isn't a font MyCanvas can read (use a .ttf or .otf file).");
  }
  if (Array.isArray(face.fonts)) {
    throw new FontError("This is a font collection (.ttc). Upload the single .ttf or .otf files instead.");
  }
  const family = (face.getName?.("preferredFamily") ?? face.familyName ?? "").trim();
  if (family === "" || (face.numGlyphs ?? 0) === 0) {
    throw new FontError("The font has no family name or no letters, so it can't be used.");
  }
  const style = (face.getName?.("preferredSubfamily") ?? face.subfamilyName ?? "").toLowerCase();
  // The OS/2 table: weight class and italic/oblique flags.
  const os2 = (face as unknown as Record<string, { usWeightClass?: number; fsSelection?: { italic?: boolean; oblique?: boolean } } | undefined>)["OS/2"];
  const rawWeight = os2?.usWeightClass ?? (style.includes("bold") ? 700 : 400);
  const weight = Math.min(900, Math.max(100, Math.round(rawWeight / 100) * 100));
  const italic = os2?.fsSelection?.italic === true || os2?.fsSelection?.oblique === true || style.includes("italic") || style.includes("oblique");
  const variable = Boolean(face.variationAxes && "wght" in face.variationAxes);
  return { family, weight, italic, variable };
}

/**
 * Stores a font face. A face with the same family, weight and style as an
 * existing one replaces it.
 */
export async function saveFont(ws: Workspace, bytes: Buffer, fileName: string, familyOverride?: string): Promise<{ font: CustomFont; replaced: boolean }> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".woff" || ext === ".woff2") {
    throw new FontError("WOFF/WOFF2 web fonts can't be embedded in PDFs. Upload the .ttf or .otf version.");
  }
  if (!(ext in FONT_TYPES)) {
    throw new FontError(`Unsupported font type: ${ext || "(none)"} (use .ttf or .otf).`);
  }
  const parsed = parseFont(bytes);
  const override = familyOverride?.trim().slice(0, 80) ?? "";
  const family = override === "" ? parsed.family : override;
  await mkdir(fontsDir(ws), { recursive: true });
  const file = `${newId()}${ext}`;
  await writeFile(path.join(fontsDir(ws), file), bytes);
  const fonts = await listFonts(ws);
  const same = fonts.find((font) => font.family.toLowerCase() === family.toLowerCase() && font.weight === parsed.weight && font.italic === parsed.italic);
  const font: CustomFont = {
    id: file,
    family: same?.family ?? family,
    weight: parsed.weight,
    italic: parsed.italic,
    variable: parsed.variable,
    originalName: fileName,
    uploadedAt: new Date().toISOString(),
  };
  const next = fonts.filter((entry) => entry !== same);
  next.push(font);
  await writeJsonFile(manifestFile(ws), next);
  if (same) {
    await unlink(path.join(fontsDir(ws), same.id)).catch(() => undefined);
  }
  return { font, replaced: Boolean(same) };
}

export async function deleteFont(ws: Workspace, id: string): Promise<boolean> {
  const fonts = await listFonts(ws);
  if (!fonts.some((font) => font.id === id)) {
    return false;
  }
  await writeJsonFile(manifestFile(ws), fonts.filter((font) => font.id !== id));
  await unlink(path.join(fontsDir(ws), id)).catch(() => undefined);
  return true;
}

export async function readFontFile(ws: Workspace, file: string): Promise<Buffer | null> {
  if (!isSafeFontFile(file)) {
    return null;
  }
  return readFile(path.join(fontsDir(ws), file)).catch(() => null);
}

function cssString(value: string): string {
  return `"${value.replace(/["\\\n\r]/g, "")}"`;
}

/** @font-face rules for every face, served as /api/fonts/custom.css. */
export function fontFaceCss(fonts: CustomFont[]): string {
  return fonts.map((font) => [
    "@font-face {",
    `  font-family: ${cssString(font.family)};`,
    `  src: url("/fonts/${font.id}") format("${font.id.endsWith(".otf") ? "opentype" : "truetype"}");`,
    // A variable font covers the whole weight range.
    `  font-weight: ${font.variable ? "100 900" : String(font.weight)};`,
    `  font-style: ${font.italic ? "italic" : "normal"};`,
    "  font-display: block;",
    "}",
  ].join("\n")).join("\n\n") + "\n";
}
