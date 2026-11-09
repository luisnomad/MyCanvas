import { type Design } from "@mycanvas/shared";
import { aiImage, aiText } from "./ai-client";
import { CONTENT_SYNTAX } from "./content-markdown";

/*
 * AI help for format content. The model only restructures and suggests;
 * the layout stays deterministic. Prompts and checks live here.
 */

/** Same shape as the server's answer, whichever side ran the model. */
async function aiTextResult(request: Parameters<typeof aiText>[0]): Promise<{ text: string }> {
  return { text: await aiText(request) };
}

/** Paragraph-sized units of the content (blank-line separated), with their text. */
function units(markdown: string): string[] {
  return markdown.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((unit) => unit.trim()).filter(Boolean);
}

/** Parts of at most ~maxChars, cut between paragraphs. */
function chunks(markdown: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const unit of units(markdown)) {
    if (current && current.length + unit.length + 2 > maxChars) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${unit}` : unit;
  }
  if (current) {
    out.push(current);
  }
  return out;
}

/** The words of the content, without markup: what the reader reads. */
export function wordsOf(markdown: string): string[] {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^\s*(?:#{1,6}|>|[-*•]|\\)\s?/gm, " ")
    .replace(/\*\*|__/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** How many words differ between two texts (as multisets), and a few examples. */
export function wordingChanges(before: string, after: string): { changed: number; total: number; examples: string[] } {
  const counts = new Map<string, number>();
  const a = wordsOf(before);
  const b = wordsOf(after);
  for (const word of a) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  for (const word of b) {
    counts.set(word, (counts.get(word) ?? 0) - 1);
  }
  let changed = 0;
  const examples: string[] = [];
  for (const [word, count] of counts) {
    if (count !== 0) {
      changed += Math.abs(count);
      if (examples.length < 6) {
        examples.push(count > 0 ? `−${word}` : `+${word}`);
      }
    }
  }
  return { changed, total: Math.max(a.length, b.length), examples };
}

const DIALECT = CONTENT_SYNTAX.map((entry) => `${entry.syntax}  →  ${entry.meaning}`).join("\n");

/** Block kinds the format has its own look for (its samples). */
function styledKinds(format: Design): string[] {
  const kinds = new Set<string>();
  for (const page of format.pages) {
    for (const layer of page.layers) {
      if (layer.formatRole?.kind === "sample") {
        kinds.add(layer.formatRole.block);
      }
    }
  }
  return [...kinds];
}

function tidySystem(format: Design, part: number, parts: number): string {
  const rules = format.formatAi?.contentRules?.trim();
  return [
    "You prepare document content for an automatic layout engine. The content is written in this Markdown dialect:",
    DIALECT,
    "",
    "Your job is to fix the STRUCTURE only. Never change the words: do not rewrite, correct, translate, summarise, add or remove any text.",
    "You may: give each paragraph the right marker (# title, ## heading, **…** lead, > callout, - list item); join lines that were split in the middle of a sentence; split a paragraph that runs two different blocks together; drop stray page counters such as \"03 / 10\".",
    "Keep image lines (![…](…)) and --- lines exactly as they are, in place.",
    `This format has its own look for: ${styledKinds(format).join(", ") || "body text"}. Prefer those kinds.`,
    parts > 1 ? `This is part ${String(part)} of ${String(parts)} of one document.${part > 1 ? " The title is in part 1: do not add a # title here." : ""}` : "",
    rules ? `The person's rules for this format (follow them):\n${rules}` : "",
    "",
    "Answer with the content only: no explanations, no code fences.",
  ].filter((line) => line !== "").join("\n");
}

export interface TidyResult {
  markdown: string;
  /** Words added or removed by the model (0 when it kept the wording). */
  changed: number;
  total: number;
  examples: string[];
}

/** Restructures content with the text model, part by part; reports any wording changes. */
export async function tidyContent(markdown: string, format: Design, onProgress: (message: string) => void): Promise<TidyResult> {
  const parts = chunks(markdown, 6000);
  const out: string[] = [];
  for (const [index, part] of parts.entries()) {
    onProgress(parts.length > 1 ? `Tidying part ${String(index + 1)} of ${String(parts.length)}…` : "Tidying…");
    const { text } = await aiTextResult({ system: tidySystem(format, index + 1, parts.length), prompt: part, temperature: 0 });
    out.push(text.trim());
  }
  const result = `${out.join("\n\n")}\n`;
  return { markdown: result, ...wordingChanges(markdown, result) };
}

export interface IllustrationPlan {
  /** Insert after this content unit (0-based, blank-line separated). */
  after: number;
  /** What to depict, in plain words. */
  subject: string;
}

/** Asks the text model where illustrations help and what they should show. */
export async function planIllustrations(markdown: string, format: Design, count: number): Promise<IllustrationPlan[]> {
  const list = units(markdown);
  const numbered = list
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => !unit.startsWith("![") && !/^-{3,}$/.test(unit))
    .map(({ unit, index }) => `[${String(index)}] ${unit.slice(0, 400)}`)
    .join("\n");
  const style = format.formatAi?.illustrationStyle?.trim();
  const system = [
    "You are an art director placing illustrations in a document. You read numbered paragraphs and choose where a picture would help the reader understand or remember the idea.",
    `Choose at most ${String(count)} places, spread through the document, never two in a row, and not right after the title.`,
    "For each, describe the picture's subject in one concrete English sentence: objects, people or scene and what they do. No words, letters, numbers or logos in the picture.",
    style ? `The pictures will be drawn in this style (don't repeat it, just make subjects that suit it): ${style}` : "",
    "Answer JSON only: {\"illustrations\":[{\"after\": <paragraph number>, \"subject\": \"…\"}]}",
  ].filter(Boolean).join("\n");
  const { text } = await aiTextResult({ system, prompt: numbered, json: true, temperature: 0.4 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    parsed = match ? JSON.parse(match[0]) : null;
  }
  const items = (parsed as { illustrations?: unknown } | null)?.illustrations;
  if (!Array.isArray(items)) {
    throw new Error("The text model didn't return a usable plan. Try again, or try another model.");
  }
  const seen = new Set<number>();
  return items
    .map((item) => item as { after?: unknown; subject?: unknown })
    .filter((item): item is { after: number; subject: string } =>
      typeof item.after === "number" && Number.isInteger(item.after) && item.after >= 0 && item.after < list.length &&
      typeof item.subject === "string" && item.subject.trim() !== "")
    .filter((item) => !seen.has(item.after) && Boolean(seen.add(item.after)))
    .slice(0, count)
    .map((item) => ({ after: item.after, subject: item.subject.trim() }));
}

/** The full image prompt: the subject in the format's style. */
export function illustrationPrompt(subject: string, format: Design): string {
  let style = format.formatAi?.illustrationStyle?.trim() ?? "";
  if (style === "") {
    style = "Clean editorial illustration, simple shapes, soft light, plenty of plain background";
  }
  return `${subject.replace(/\.$/, "")}. Style: ${style}. No text, no letters, no logos.`;
}

/** Width and height for illustrations: the format's image sample, else square. */
export function illustrationSize(format: Design): { width: number; height: number } {
  for (const page of format.pages) {
    for (const layer of page.layers) {
      if (layer.type === "image" && layer.formatRole?.kind === "sample") {
        const width = layer.width * layer.scaleX;
        const height = layer.height * layer.scaleY;
        const scale = 1024 / Math.max(width, height);
        return { width: Math.round(width * scale), height: Math.round(height * scale) };
      }
    }
  }
  return { width: 1024, height: 1024 };
}

/** Generates an illustration with the chosen image model; resolves to the new upload's file name. */
export function generateImageAsset(prompt: string, size: { width: number; height: number }, name: string): Promise<string> {
  return aiImage(prompt, size, name);
}

/** Inserts image lines after the chosen units (from the end, so indexes stay valid). */
export function insertImages(markdown: string, placed: { after: number; line: string }[]): string {
  const list = units(markdown);
  for (const { after, line } of [...placed].sort((a, b) => b.after - a.after)) {
    list.splice(after + 1, 0, line);
  }
  return `${list.join("\n\n")}\n`;
}
