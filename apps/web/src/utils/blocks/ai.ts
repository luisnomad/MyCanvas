import { aiText } from "../ai-client";
import { wordsOf } from "../ai-content";
import { parseJsonAnswer } from "../format-review/edits";
import { BLOCK_LIST, type BlockSpec, slotProblems } from "./catalog";
import { type PlannedPart, planWithRules } from "./rules";
import { readPlannedPart } from "./plan";

/*
 * The AI splits content into parts and picks a block for each, filling its
 * slots with the author's words. Answers are checked against each block's
 * limits; a part that breaks them goes back once with the problems listed,
 * and whatever is still wrong is repaired in code afterwards.
 */

function describeSpec(spec: BlockSpec, pictures: boolean): string {
  const slots: string[] = [];
  for (const [slot, limit] of Object.entries(spec.text)) {
    slots.push(`${slot} (≤${String(limit.max)}${limit.required ? ", required" : ""})`);
  }
  if (spec.items) {
    const fields = Object.entries(spec.items.fields).map(([field, limit]) => `${field} ≤${String(limit.max)}${limit.required ? " required" : ""}`).join(", ");
    slots.push(`items: ${String(spec.items.min)}–${String(spec.items.max)} × {${fields}}`);
  }
  if (spec.compare) {
    slots.push(`left and right: {label ≤${String(spec.compare.label)}, items: ${String(spec.compare.min)}–${String(spec.compare.max)} strings ≤${String(spec.compare.item)}}`);
  }
  if (spec.picture) {
    slots.push("image (a file name from the content, only if it has one)");
    if (pictures) {
      slots.push("imageQuery (≤120, a picture to make for the page)");
    }
  }
  return `- ${spec.type}: ${spec.description}. Slots: ${slots.join("; ")}`;
}

function system(pictures: boolean): string {
  const pictureRule = pictures
    ? `- Pictures: an image that is in the content (written ![alt](file)) goes in "image" on a "pictureText" page. Pictures can also be made: give the cover, and "pictureText" pages for ideas that are easy to picture, an "imageQuery" in English describing one concrete photo (subject, setting, mood, no text in it). At most one page in three gets a picture; leave "imageQuery" out everywhere else.`
    : `- "pictureText" only for images that are in the content (written ![alt](file)); put that file name in "image".`;
  return `You lay out content as a carousel: one visual block per page.

Blocks you can use:
${BLOCK_LIST.map((spec) => describeSpec(spec, pictures)).join("\n")}

Rules:
- Use the author's own words and language. Shorten only to fit a limit, never add facts, figures, names or claims. ≤N means at most N characters.
- Optional slots (kicker, subtitle, author, role, handle, action) stay out unless the content has that text. Don't write taglines or labels of your own.
- One idea per page. Keep the content's order.
- Start with "cover" when the content has a title. Use "closing" only if the content ends with a call to action or wrap-up.
- Pick the block that matches the content's shape: an ordered process → steps; parallel ideas → cards; a list → points; figures that are in the text → stats; two sides → compare; dates → timeline; a key sentence → statement; someone's words → quote; a heading that opens a part → section.
- Vary blocks; avoid the same block more than twice in a row.
${pictureRule}
- Everything important in the content must appear on some page.

Answer with JSON only: {"parts":[{"block":"cover","slots":{"title":"…","subtitle":"…"}},{"block":"steps","slots":{"title":"…","items":[{"label":"…","text":"…"}]}}]}`;
}

/** Splits content at headings into chunks of about `size` characters. */
function chunks(markdown: string, size = 5000): string[] {
  const out: string[] = [];
  let current = "";
  for (const section of markdown.split(/\n(?=#{1,6}\s)/)) {
    if (current && current.length + section.length > size) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n${section}` : section;
  }
  if (current.trim()) {
    out.push(current);
  }
  return out;
}

function imagesOf(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g)].map((match) => (match[1] ?? "").replace(/^\/?assets\//, "")));
}

function readParts(answer: string, images: Set<string>): { parts: PlannedPart[]; dropped: number } {
  const parsed = parseJsonAnswer(answer) as { parts?: unknown } | unknown[] | null;
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.parts) ? parsed.parts as unknown[] : [];
  const parts: PlannedPart[] = [];
  let dropped = 0;
  for (const entry of list) {
    const part = readPlannedPart(entry, images);
    if (part) {
      parts.push(part);
    } else {
      dropped += 1;
    }
  }
  return { parts, dropped };
}

async function fixPart(part: PlannedPart, problems: string[], images: Set<string>, pictures: boolean): Promise<PlannedPart> {
  const answer = await aiText({
    system: system(pictures),
    prompt: `This page breaks its block's limits:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\nPage:\n${JSON.stringify(part)}\n\nAnswer with the corrected page only, same JSON shape ({"block":…,"slots":…}). You may pick another block if the content fits it better. Shorten by rephrasing, keeping the meaning and language.`,
    json: true,
    temperature: 0.2,
  });
  const fixed = readPlannedPart(parseJsonAnswer(answer), images);
  return fixed ?? part;
}

export interface AiPlan {
  parts: PlannedPart[];
  warnings: string[];
}

export async function planWithAi(markdown: string, onProgress: (message: string) => void, options: { pictures?: boolean } = {}): Promise<AiPlan> {
  const pictures = options.pictures ?? false;
  const images = imagesOf(markdown);
  const warnings: string[] = [];
  const parts: PlannedPart[] = [];
  const pieces = chunks(markdown);
  for (const [index, piece] of pieces.entries()) {
    onProgress(pieces.length > 1 ? `Planning pages (part ${String(index + 1)} of ${String(pieces.length)})…` : "Planning pages…");
    const answer = await aiText({
      system: system(pictures),
      prompt: `${index > 0 ? "This continues earlier content: no cover.\n\n" : ""}Content:\n\n${piece}`,
      json: true,
      temperature: 0.2,
    });
    const read = readParts(answer, images);
    if (read.parts.length === 0) {
      // Unusable answer: this piece falls back to the rules.
      warnings.push(`The AI's answer for ${pieces.length > 1 ? `part ${String(index + 1)}` : "the content"} couldn't be used, so the pages there follow the content's structure instead.`);
      parts.push(...planWithRules(piece).filter((part) => index === 0 || part.block !== "cover"));
      continue;
    }
    if (read.dropped > 0) {
      warnings.push(`${String(read.dropped)} page${read.dropped === 1 ? "" : "s"} the AI suggested used an unknown block and were left out.`);
    }
    parts.push(...read.parts);
  }

  // One round of fixes for parts that break their limits.
  const broken = parts.map((part, index) => ({ index, problems: slotProblems(part.block, part.slots) })).filter((entry) => entry.problems.length > 0);
  for (const [count, entry] of broken.entries()) {
    onProgress(`Fixing pages that don't fit (${String(count + 1)} of ${String(broken.length)})…`);
    const part = parts[entry.index];
    if (part) {
      try {
        parts[entry.index] = await fixPart(part, entry.problems, images, pictures);
      } catch {
        // Keep it; the repair step makes it drawable.
      }
    }
  }

  // Did everything make it in? Words of the content missing from the pages.
  const pageWords = new Set(wordsOf(JSON.stringify(parts.map(({ slots: { imageQuery: _query, ...shown } }) => shown))));
  const contentWords = wordsOf(markdown).filter((word) => word.length > 3);
  const missing = contentWords.filter((word) => !pageWords.has(word));
  if (contentWords.length > 0 && missing.length / contentWords.length > 0.35) {
    warnings.push(`The AI shortened the content: about ${String(Math.round((missing.length / contentWords.length) * 100))}% of its words aren't on the pages. Check that nothing important was left out.`);
  }
  return { parts, warnings };
}
