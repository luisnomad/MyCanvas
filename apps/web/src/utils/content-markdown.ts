import { type BlockKind } from "@mycanvas/shared";

/*
 * Content for document formats: a small Markdown dialect. Pure functions,
 * no DOM, so the parser can be tested and reused (e.g. by AI import).
 */

export interface ContentBlock {
  kind: BlockKind;
  /** Text for text blocks; alt text for images. */
  text: string;
  /** Upload file name, for image blocks. */
  asset?: string;
}

export type ContentItem = ContentBlock | { kind: "pageBreak" };

/** Syntax help shown next to the content editor. */
export const CONTENT_SYNTAX: { syntax: string; meaning: string }[] = [
  { syntax: "# Title", meaning: "Title (consecutive # lines stay one title)" },
  { syntax: "**A whole bold paragraph**", meaning: "Lead" },
  { syntax: "## Heading", meaning: "Heading" },
  { syntax: "Plain paragraph", meaning: "Body text" },
  { syntax: "- item", meaning: "Bullet list (body text)" },
  { syntax: "> Callout", meaning: "Callout" },
  { syntax: "![name](file.png)", meaning: "Image from your uploads" },
  { syntax: "---", meaning: "Start a new page" },
];

/** Drops inline emphasis markers; formats style whole blocks, not words. */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").trim();
}

/**
 * Parses content into blocks. Deliberately forgiving: anything that isn't
 * recognised syntax is body text, so pasted documents always come through.
 */
export function parseContent(markdown: string): ContentItem[] {
  const items: ContentItem[] = [];
  interface OpenBlock {
    kind: BlockKind;
    lines: string[];
    joiner: string;
  }
  // Cast: assigned inside closures, so don't let TS narrow it to null.
  let open = null as OpenBlock | null;

  const flush = () => {
    if (!open) {
      return;
    }
    const raw = open.lines.join(open.joiner).trim();
    if (raw) {
      // A paragraph that is bold from start to end is a lead.
      const lead = open.kind === "body" ? /^\*\*([^*]+)\*\*$/s.exec(raw) : null;
      items.push(lead?.[1] ? { kind: "lead", text: plain(lead[1]) } : { kind: open.kind, text: plain(raw) });
    }
    open = null;
  };
  const start = (kind: BlockKind, line: string, joiner: string) => {
    flush();
    open = { kind, lines: [line], joiner };
  };

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    // A leading "\" makes the rest of the line plain text (e.g. "\1. Not a list").
    const escaped = trimmed.startsWith("\\");
    const line = escaped ? trimmed.slice(1) : trimmed;
    const syntax = escaped ? "" : line;
    const title = /^#\s+(.*)$/.exec(syntax);
    const heading = /^#{2,6}\s+(.*)$/.exec(syntax);
    const quote = /^>\s?(.*)$/.exec(syntax);
    const image = /^!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)$/.exec(syntax);
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(syntax);

    if (!line) {
      flush();
    } else if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(syntax)) {
      flush();
      items.push({ kind: "pageBreak" });
    } else if (title) {
      if (open?.kind === "title") {
        open.lines.push(title[1] ?? "");
      } else {
        start("title", title[1] ?? "", "\n");
      }
    } else if (heading) {
      start("heading", heading[1] ?? "", " ");
      flush();
    } else if (quote) {
      const text = quote[1] ?? "";
      if (open?.kind === "callout") {
        // An empty ">" line inside a callout starts a new paragraph in it.
        open.lines.push(text ? text : "\n");
      } else {
        start("callout", text, " ");
      }
    } else if (image) {
      flush();
      items.push({ kind: "image", text: image[1] ?? "", asset: (image[2] ?? "").replace(/^\/?assets\//, "") });
    } else if (bullet) {
      const text = `• ${bullet[1] ?? ""}`;
      if (open?.kind === "body" && open.joiner === "\n") {
        open.lines.push(text);
      } else {
        start("body", text, "\n");
      }
    } else if (open?.kind === "body" || open?.kind === "callout") {
      open.lines.push(line);
    } else {
      start("body", line, " ");
    }
  }
  flush();
  // "\n" pushed for empty ">" lines shouldn't leave spaces around the break.
  return items.map((item) => ("text" in item ? { ...item, text: item.text.replace(/ ?\n ?/g, "\n") } : item));
}
