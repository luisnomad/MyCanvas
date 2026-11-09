import { type BlockKind } from "@mycanvas/shared";
import { type TextBlock } from "./analyze-pdf";

/*
 * Decides what each text block of an example is: furniture (running
 * header/footer text), or the title/lead/heading/body/callout whose look
 * the format should copy. Pure: works on measured blocks only.
 */

export interface ExamplePage {
  width: number;
  height: number;
  blocks: TextBlock[];
  pictures?: { x: number; y: number; width: number; height: number }[];
}

export interface RoleSample {
  block: TextBlock;
  page: number;
  /** Text for the sample (title lines merged). */
  text: string;
  /** Font size, pt (the smallest line's for a merged title). */
  size: number;
  /** Line spacing ÷ size. */
  lineHeight: number;
  /** Gap above blocks of this kind, pt (median measured in the example). */
  spaceBefore: number;
}

export interface ExampleRoles {
  samples: Partial<Record<Exclude<BlockKind, "image">, RoleSample>>;
  /** Small text at the very top/bottom of a page: kept as decoration. */
  furniture: { page: number; block: TextBlock }[];
  /** Blocks that are content (go into the flow area), per page. */
  content: TextBlock[][];
}

type TextKind = Exclude<BlockKind, "image">;

function styleKey(block: TextBlock): string {
  return [block.font.use, block.font.weight, block.font.italic, Math.round(block.size * 2) / 2, block.color, block.box ? "box" : ""].join("|");
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export function classifyExample(pages: ExamplePage[]): ExampleRoles {
  const furniture: ExampleRoles["furniture"] = [];
  const content: TextBlock[][] = pages.map(() => []);
  const all: { block: TextBlock; page: number }[] = [];

  // Body size first (most text), to recognise small furniture.
  const chars = new Map<number, number>();
  for (const page of pages) {
    for (const block of page.blocks) {
      const size = Math.round(block.size * 2) / 2;
      chars.set(size, (chars.get(size) ?? 0) + block.text.length);
    }
  }
  const bodySizeGuess = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;

  pages.forEach((page, index) => {
    for (const block of page.blocks) {
      const atEdge = block.y < page.height * 0.06 || block.y + block.height > page.height * 0.91;
      if (atEdge && block.size <= bodySizeGuess * 1.1 && !block.box) {
        furniture.push({ page: index, block });
      } else {
        content[index]?.push(block);
        all.push({ block, page: index });
      }
    }
  });

  // Group content by look.
  const styles = new Map<string, { blocks: { block: TextBlock; page: number }[]; chars: number }>();
  for (const entry of all) {
    const key = styleKey(entry.block);
    const style = styles.get(key) ?? { blocks: [], chars: 0 };
    style.blocks.push(entry);
    style.chars += entry.block.text.length;
    styles.set(key, style);
  }
  const taken = new Set<string>();
  const samples: ExampleRoles["samples"] = {};
  const roleOfKey = new Map<string, TextKind>();

  // Callout: text on a coloured box.
  const callout = all.find((entry) => entry.block.box);
  if (callout) {
    const key = styleKey(callout.block);
    taken.add(key);
    roleOfKey.set(key, "callout");
  }

  // Body: the look with the most text.
  const bodyKey = [...styles].filter(([key]) => !taken.has(key)).sort((a, b) => b[1].chars - a[1].chars)[0]?.[0];
  const body = bodyKey ? styles.get(bodyKey)?.blocks[0]?.block : undefined;
  if (bodyKey) {
    taken.add(bodyKey);
    roleOfKey.set(bodyKey, "body");
  }
  const bodySize = body?.size ?? bodySizeGuess;
  const bodyWeight = body?.font.weight ?? 400;

  // Title: the biggest text near the top of the first page.
  const titleCandidate = all
    .filter((entry) => entry.page === 0 && entry.block.size >= bodySize * 1.6)
    .sort((a, b) => a.block.y - b.block.y)[0];
  if (titleCandidate) {
    const key = styleKey(titleCandidate.block);
    roleOfKey.set(key, "title");
    taken.add(key);
  }

  // Heading: short, bold or bigger text that repeats.
  const remaining = [...styles].filter(([key]) => !taken.has(key));
  const headingKey = remaining
    .filter(([, style]) => {
      const sample = style.blocks[0]?.block;
      const avg = style.chars / style.blocks.length;
      // Bare numbers or symbols (step counters, icons) aren't headings.
      const words = style.blocks.some(({ block }) => /\p{L}{2,}/u.test(block.text));
      return sample !== undefined && words && avg <= 90 && (sample.size >= bodySize * 1.08 || sample.font.weight > bodyWeight);
    })
    .sort((a, b) => b[1].blocks.length - a[1].blocks.length || (b[1].blocks[0]?.block.size ?? 0) - (a[1].blocks[0]?.block.size ?? 0))[0]?.[0];
  if (headingKey) {
    taken.add(headingKey);
    roleOfKey.set(headingKey, "heading");
  }

  // Lead: an emphasised paragraph (bigger or bolder than body), usually early.
  const leadKey = [...styles]
    .filter(([key, style]) => {
      const sample = style.blocks[0]?.block;
      return !taken.has(key) && sample !== undefined && (sample.size >= bodySize * 1.03 || sample.font.weight > bodyWeight) && style.chars / style.blocks.length > 30;
    })
    .sort((a, b) => (a[1].blocks[0]?.page ?? 0) - (b[1].blocks[0]?.page ?? 0) || (a[1].blocks[0]?.block.y ?? 0) - (b[1].blocks[0]?.block.y ?? 0))[0]?.[0];
  if (leadKey) {
    taken.add(leadKey);
    roleOfKey.set(leadKey, "lead");
  }

  // Spacing: the gap above each block, collected per role.
  const gaps = new Map<TextKind, number[]>();
  for (const [pageIndex, pageBlocks] of content.entries()) {
    const pictures = pages[pageIndex]?.pictures ?? [];
    const ordered = [...pageBlocks].sort((a, b) => a.y - b.y);
    ordered.forEach((block, index) => {
      const previous = ordered[index - 1];
      const role = roleOfKey.get(styleKey(block));
      if (!previous || !role) {
        return;
      }
      const top = block.box ? block.box.y : block.y;
      const previousBottom = previous.box ? previous.box.y + previous.box.height : previous.y + previous.height;
      const gap = top - previousBottom;
      // A picture between the two blocks isn't spacing.
      const pictureBetween = pictures.some((picture) => picture.y < top && picture.y + picture.height > previousBottom);
      if (gap >= 0 && gap < 120 && !pictureBetween) {
        gaps.set(role, [...(gaps.get(role) ?? []), gap]);
      }
    });
  }

  for (const [key, role] of roleOfKey) {
    const first = styles.get(key)?.blocks[0];
    if (!first) {
      continue;
    }
    let text = first.block.text;
    let size = first.block.size;
    let lineHeight = first.block.lineHeight;
    if (role === "title") {
      // A title set on several blocks (lines in different sizes) becomes one sample.
      const lines = all
        .filter((entry) => entry.page === 0 && entry.block.font.use === first.block.font.use && entry.block.color === first.block.color && entry.block.size >= bodySize * 1.6)
        .sort((a, b) => a.block.y - b.block.y);
      text = lines.map((entry) => entry.block.text).join("\n");
      // Lines set in different sizes were fitted to their width: the smallest is
      // the size new title text can take without overflowing.
      size = Math.min(...lines.map((entry) => entry.block.size), size);
      const firstLine = lines[0]?.block;
      const lastLine = lines[lines.length - 1]?.block;
      if (lines.length > 1 && firstLine && lastLine) {
        // Distance between the first and last baselines, per line, relative to size
        // (tops differ when the lines are set in different sizes).
        lineHeight = Math.min(2, Math.max(0.8, (lastLine.baseline - firstLine.baseline) / (lines.length - 1) / size));
      }
    }
    samples[role] = {
      block: first.block,
      page: first.page,
      text,
      size,
      lineHeight,
      spaceBefore: Math.round(median(gaps.get(role) ?? []) ?? (role === "heading" ? 24 : 12)),
    };
  }

  return { samples, furniture, content };
}
