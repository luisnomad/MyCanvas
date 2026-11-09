import { type BlockItem, type BlockSlots, type VisualBlockType } from "@mycanvas/shared";
import { type ContentBlock, parseContent } from "../content-markdown";
import { BLOCKS } from "./catalog";

/*
 * Content → visual blocks without AI: the Markdown's own structure decides.
 * A title opens a cover, each heading opens a part, numbered lists become
 * steps, "Label: text" lists become cards, callouts become statements or
 * quotes. Plainer than the AI, but every word comes through.
 */

export interface PlannedPart {
  block: VisualBlockType;
  slots: BlockSlots;
}

const NUMBERED = "⁂ ";

/** "Label: sentence" (or "Label — sentence") → both parts. */
export function labelled(text: string): BlockItem | null {
  const match = /^\*{0,2}([^:—–]{2,40}?)\*{0,2}\s*[:—–]\s+(.+)$/s.exec(text);
  return match?.[1] && match[2] ? { label: match[1].trim(), text: match[2].trim() } : null;
}

/** A leading figure ("72% of…", "3x faster", "1.200 people") → value and label. */
export function figure(text: string): BlockItem | null {
  const match = /^([+\-~]?[\d.,]+\s?(?:%|x|k|M|€|\$)?)\s+(.{4,80})$/s.exec(text.trim());
  return match?.[1] && match[2] ? { value: match[1].replace(/\s/g, ""), label: match[2].trim() } : null;
}

/** "“Words” — Someone, Role" → quote parts. */
function quoted(text: string): BlockSlots | null {
  const match = /^[“"«](.+?)[”"»]\s*(?:[—–-]\s*([^,\n]+)(?:,\s*(.+))?)?$/s.exec(text.trim());
  if (!match?.[1]) {
    return null;
  }
  return { text: match[1].trim(), ...(match[2] ? { author: match[2].trim() } : {}), ...(match[3] ? { role: match[3].trim() } : {}) };
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"“])/).map((sentence) => sentence.trim()).filter(Boolean);
}

/** Splits a long list over several parts of the same block. */
function chunked(block: VisualBlockType, title: string | undefined, items: BlockItem[]): PlannedPart[] {
  const max = BLOCKS[block].items?.max ?? 5;
  if (items.length <= max) {
    return [{ block, slots: { title, items } }];
  }
  const parts: PlannedPart[] = [];
  const count = Math.ceil(items.length / max);
  const size = Math.ceil(items.length / count);
  for (let start = 0; start < items.length; start += size) {
    parts.push({ block, slots: { title, items: items.slice(start, start + size) } });
  }
  return parts;
}

/** One section (a heading and what follows it) → one or more parts. */
function sectionParts(heading: string | undefined, blocks: ContentBlock[]): PlannedPart[] {
  const parts: PlannedPart[] = [];
  const paragraphs: string[] = [];
  let title = heading;

  const flushParagraphs = () => {
    if (paragraphs.length === 0) {
      return;
    }
    const text = paragraphs.join(" ");
    paragraphs.length = 0;
    const figures = text.split(/\n/).map(figure);
    if (figures.length <= 3 && figures.every((entry) => entry !== null)) {
      parts.push({ block: "stats", slots: { title, items: figures } });
    } else if (text.length <= 130) {
      parts.push({ block: "statement", slots: { kicker: title, text } });
    } else {
      // A longer paragraph: its sentences as points.
      const list = sentences(text).map((sentence) => ({ text: sentence }));
      parts.push(...chunked("points", title, list));
    }
    title = undefined;
  };

  for (const block of blocks) {
    if (block.kind === "image") {
      flushParagraphs();
      parts.push({ block: "pictureText", slots: { title: title ?? block.text, image: block.asset, imageQuery: block.text } });
      title = undefined;
      continue;
    }
    if (block.kind === "callout") {
      flushParagraphs();
      const quote = quoted(block.text);
      parts.push(quote ? { block: "quote", slots: quote } : { block: "statement", slots: { kicker: title, text: block.text } });
      title = undefined;
      continue;
    }
    const lines = block.text.split("\n");
    if (lines.every((line) => line.startsWith("• "))) {
      flushParagraphs();
      const numbered = lines.every((line) => line.startsWith(`• ${NUMBERED}`));
      const texts = lines.map((line) => line.replace(/^• /, "").replace(NUMBERED, ""));
      const withLabels = texts.map(labelled);
      const figures = texts.map(figure);
      if (figures.every((entry) => entry !== null) && texts.length <= 3) {
        parts.push({ block: "stats", slots: { title, items: figures } });
      } else if (numbered) {
        parts.push(...chunked("steps", title, texts.map((text) => labelled(text) ?? { label: text })));
      } else if (withLabels.every((entry) => entry !== null) && texts.length <= 4) {
        parts.push({ block: "cards", slots: { title, items: withLabels } });
      } else {
        parts.push(...chunked("points", title, texts.map((text) => ({ text }))));
      }
      title = undefined;
      continue;
    }
    // The paragraph right after a picture is that picture's text.
    const last = parts[parts.length - 1];
    if (paragraphs.length === 0 && last?.block === "pictureText" && !last.slots.text && block.text.length <= 220) {
      last.slots.text = block.text;
      continue;
    }
    paragraphs.push(block.text);
  }
  flushParagraphs();
  if (parts.length === 0 && title) {
    parts.push({ block: "section", slots: { title } });
  }
  return parts;
}

export function planWithRules(markdown: string): PlannedPart[] {
  // Keep numbered lists recognisable after parsing (the parser makes all lists bullets).
  const marked = markdown.replace(/^(\s*)\d+[.)]\s+/gm, `$1- ${NUMBERED}`);
  // Short lines that start with a figure ("72% of…") are a list of figures, not one paragraph.
  const figured = marked.replace(/^(?![-*•#>])(?=[+\-~]?\d[\d.,]*\s?(?:%|x|k|M|€|\$)?\s+\S)(.{1,90})$/gm, "- $1");
  const items = parseContent(figured);
  const parts: PlannedPart[] = [];
  let heading: string | undefined;
  let section: ContentBlock[] = [];
  let index = 0;

  // Title (and an optional lead) → cover.
  const first = items[0];
  if (first?.kind === "title") {
    const lead = items[1]?.kind === "lead" ? items[1] : undefined;
    const lines = first.text.split("\n");
    parts.push({ block: "cover", slots: { title: lines.join(" "), ...(lead && "text" in lead ? { subtitle: lead.text } : {}) } });
    index = lead ? 2 : 1;
  }

  const flush = () => {
    if (heading !== undefined || section.length > 0) {
      parts.push(...sectionParts(heading, section));
    }
    heading = undefined;
    section = [];
  };
  for (const item of items.slice(index)) {
    if (item.kind === "pageBreak") {
      flush();
    } else if (item.kind === "heading" || item.kind === "title") {
      flush();
      heading = item.text.replace(/\n/g, " ");
    } else {
      section.push(item.kind === "lead" ? { ...item, kind: "body" } : item);
    }
  }
  flush();
  return parts;
}
