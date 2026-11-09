/*
 * Turns paragraphs read from a file (DOCX, PPTX, PDF) into content in the
 * formats' Markdown dialect. Readers report what they know: explicit roles
 * (Word heading styles, slide title placeholders), font size and boldness.
 * Where roles are missing (documents styled by hand) size and bold decide.
 * Pure functions, so the rules are testable.
 */

export interface RawParagraph {
  text: string;
  /** Explicit role from the source; absent = infer from size and bold. */
  role?: "title" | "heading" | "subtitle" | "listItem" | "quote" | "image" | "pageBreak";
  /** Whole paragraph is bold. */
  bold?: boolean;
  /** Font size in points, when the source has it. */
  size?: number;
  /** Upload file name, for images. */
  asset?: string;
}

export interface ClassifyOptions {
  /** A big first heading may become the document title (# …). */
  detectTitle: boolean;
}

export interface ImportStats {
  headings: number;
  paragraphs: number;
  images: number;
  hasTitle: boolean;
}

type Block =
  | { kind: "title" | "heading" | "lead" | "body" | "listItem" | "quote"; text: string }
  | { kind: "image"; text: string; asset: string }
  | { kind: "pageBreak" };

/** Most common size, weighted by the amount of text set in it. */
function bodySize(paragraphs: RawParagraph[]): number | null {
  const weights = new Map<number, number>();
  for (const paragraph of paragraphs) {
    if (paragraph.size && !paragraph.role) {
      const size = Math.round(paragraph.size * 2) / 2;
      weights.set(size, (weights.get(size) ?? 0) + paragraph.text.length);
    }
  }
  let best: number | null = null;
  let bestWeight = 0;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

/** Lines that would otherwise read as Markdown syntax get a "\" in front. */
export function escapeLine(text: string): string {
  return /^(?:#|>|!\[|[-*•]\s|\d+[.)]\s|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$|\\)/.test(text) ? `\\${text}` : text;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function paragraphsToMarkdown(paragraphs: RawParagraph[], options: ClassifyOptions): { markdown: string; stats: ImportStats } {
  const body = bodySize(paragraphs);
  const hasExplicitTitle = paragraphs.some((paragraph) => paragraph.role === "title");
  let seenText = false;
  const blocks: Block[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.role === "pageBreak") {
      blocks.push({ kind: "pageBreak" });
      continue;
    }
    if (paragraph.role === "image") {
      if (paragraph.asset) {
        blocks.push({ kind: "image", text: clean(paragraph.text), asset: paragraph.asset });
      }
      continue;
    }
    const text = clean(paragraph.text);
    if (!text) {
      continue;
    }
    let kind: Exclude<Block["kind"], "image" | "pageBreak">;
    switch (paragraph.role) {
      case "title":
        kind = "title";
        break;
      case "heading":
        kind = "heading";
        break;
      case "subtitle":
        kind = "lead";
        break;
      case "listItem":
        kind = "listItem";
        break;
      case "quote":
        kind = "quote";
        break;
      default:
        if (paragraph.size && body) {
          const ratio = paragraph.size / body;
          // Title-sized text right after the title continues it (a title set on several lines).
          const previous = blocks[blocks.length - 1];
          if (ratio >= 1.8 && previous?.kind === "title" && options.detectTitle) {
            previous.text = `${previous.text}\n${text}`;
            continue;
          }
          kind = ratio >= 1.8 ? "title" : ratio >= 1.45 ? "heading" : paragraph.bold && ratio >= 1.1 ? "lead" : "body";
          if (kind === "title" && (!options.detectTitle || hasExplicitTitle || blocks.some((block) => block.kind === "title"))) {
            kind = "heading";
          }
        } else if (paragraph.bold) {
          // Styled by hand: short bold lines are headings, long ones leads.
          kind = text.length <= 70 ? "heading" : "lead";
          if (kind === "heading" && options.detectTitle && !hasExplicitTitle && !seenText && !blocks.some((block) => block.kind === "title")) {
            kind = "title";
          }
        } else {
          kind = "body";
        }
    }
    if (kind !== "title") {
      seenText = true;
    }
    blocks.push({ kind, text });
  }

  // "1" followed by "CUMPLIR" (both headings) reads as "1. CUMPLIR".
  const merged: Block[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === "heading" && block.kind === "heading" && /^\d{1,3}[.)]?$/.test(previous.text)) {
      previous.text = `${previous.text.replace(/[.)]$/, "")}. ${block.text}`;
      continue;
    }
    merged.push(block);
  }
  // A page break at the start or end, or doubled, does nothing.
  const blocksOut = merged.filter((block, index) =>
    block.kind !== "pageBreak" || (index > 0 && index < merged.length - 1 && merged[index + 1]?.kind !== "pageBreak"));

  const lines: string[] = [];
  let previousKind: Block["kind"] | null = null;
  for (const block of blocksOut) {
    // List items sit on consecutive lines; everything else is a paragraph.
    if (lines.length > 0 && !(block.kind === "listItem" && previousKind === "listItem")) {
      lines.push("");
    }
    switch (block.kind) {
      case "title":
        lines.push(...block.text.split("\n").map((line) => `# ${line}`));
        break;
      case "heading":
        lines.push(`## ${block.text}`);
        break;
      case "lead":
        lines.push(`**${block.text.replace(/\*\*/g, "")}**`);
        break;
      case "listItem":
        lines.push(`- ${block.text}`);
        break;
      case "quote":
        lines.push(`> ${block.text}`);
        break;
      case "image":
        lines.push(`![${block.text.replace(/[[\]]/g, "")}](${block.asset})`);
        break;
      case "pageBreak":
        lines.push("---");
        break;
      case "body":
        lines.push(escapeLine(block.text));
        break;
    }
    previousKind = block.kind;
  }

  return {
    markdown: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    stats: {
      headings: blocksOut.filter((block) => block.kind === "heading").length,
      paragraphs: blocksOut.filter((block) => block.kind === "body" || block.kind === "lead" || block.kind === "quote" || block.kind === "listItem").length,
      images: blocksOut.filter((block) => block.kind === "image").length,
      hasTitle: blocksOut.some((block) => block.kind === "title"),
    },
  };
}
