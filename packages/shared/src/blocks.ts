/*
 * Visual blocks: small ready-made page layouts with named slots (title,
 * items, a quote…), drawn from a theme. A design made of blocks remembers
 * each page's block and slots, so a page can switch block, variant or theme
 * and be drawn again.
 */

export const VISUAL_BLOCK_TYPES = [
  "cover",
  "statement",
  "section",
  "points",
  "steps",
  "cards",
  "stats",
  "compare",
  "quote",
  "pictureText",
  "timeline",
  "closing",
] as const;

export type VisualBlockType = (typeof VISUAL_BLOCK_TYPES)[number];

/** One entry of a list block. Which fields show depends on the block. */
export interface BlockItem {
  /** Short label: a step's name, a card's title, a timeline event. */
  label?: string;
  /** Sentence under the label (or the whole point, for plain points). */
  text?: string;
  /** Big number for stats ("72%", "3x"). */
  value?: string;
  /** Date or period for timelines ("2019", "Q3"). */
  when?: string;
}

export interface BlockSlots {
  kicker?: string;
  title?: string;
  subtitle?: string;
  /** Main sentence or paragraph. */
  text?: string;
  /** A phrase inside `text` drawn in the accent colour. */
  highlight?: string;
  /** Section number ("01"). */
  number?: string;
  author?: string;
  role?: string;
  /** Call to action ("Follow for more"). */
  action?: string;
  /** Handle or link ("@ceei"). */
  handle?: string;
  /** Uploaded asset file name. */
  image?: string;
  /** What a picture should show, for generating or finding one. */
  imageQuery?: string;
  items?: BlockItem[];
  /** Compare: the two sides. */
  left?: { label: string; items: string[] };
  right?: { label: string; items: string[] };
}

export interface BlockVariant {
  align: "left" | "center" | "right";
  /** Background: page colour, tinted surface, or the bold primary colour. */
  accent: "plain" | "tint" | "bold";
  /** Where the picture goes (picture + text, cover, quote). */
  side?: "left" | "right" | "top";
  /** Lists: one column, a row, or a grid. */
  arrange?: "list" | "row" | "grid";
}

export interface BlockTheme {
  id: string;
  name: string;
  fonts: {
    heading: { family: string; style: string };
    body: { family: string; style: string };
  };
  colors: {
    background: string;
    surface: string;
    primary: string;
    /** Text on the primary colour. */
    onPrimary: string;
    text: string;
    muted: string;
  };
  /** Corner radius for cards and boxes, px at 1080 wide. */
  radius: number;
}

export interface VisualPart {
  id: string;
  /** The page this part is drawn on. */
  pageId: string;
  block: VisualBlockType;
  variant: BlockVariant;
  slots: BlockSlots;
}

export interface BlockDesign {
  theme: BlockTheme;
  parts: VisualPart[];
  /** The content the design was made from. */
  markdown: string;
  generatedAt: string;
}

const text = (value: unknown, max = 2000): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined;

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

const color = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;

function cleanItem(value: unknown): BlockItem {
  const item = (value ?? {}) as Record<string, unknown>;
  const out: BlockItem = {};
  for (const key of ["label", "text", "value", "when"] as const) {
    const entry = text(item[key], 600);
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}

function cleanSide(value: unknown): { label: string; items: string[] } | undefined {
  const side = value as { label?: unknown; items?: unknown } | null | undefined;
  if (!side || typeof side !== "object") {
    return undefined;
  }
  const items = Array.isArray(side.items) ? side.items.flatMap((entry) => text(entry, 600) ?? []).slice(0, 12) : [];
  return { label: text(side.label, 200) ?? "", items };
}

export function cleanSlots(value: unknown): BlockSlots {
  const slots = (value ?? {}) as Record<string, unknown>;
  const out: BlockSlots = {};
  for (const key of ["kicker", "title", "subtitle", "text", "highlight", "number", "author", "role", "action", "handle", "image", "imageQuery"] as const) {
    const entry = text(slots[key]);
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  if (Array.isArray(slots.items)) {
    out.items = slots.items.slice(0, 12).map(cleanItem);
  }
  const left = cleanSide(slots.left);
  const right = cleanSide(slots.right);
  if (left) {
    out.left = left;
  }
  if (right) {
    out.right = right;
  }
  return out;
}

/** A stored or received block design, checked field by field (unknown → dropped). */
export function cleanBlockDesign(value: unknown): BlockDesign | undefined {
  const candidate = value as Partial<Record<keyof BlockDesign, unknown>> | null | undefined;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.parts)) {
    return undefined;
  }
  const theme = (candidate.theme ?? {}) as Record<string, unknown>;
  const fonts = (theme.fonts ?? {}) as Record<string, { family?: unknown; style?: unknown } | undefined>;
  const colors = (theme.colors ?? {}) as Record<string, unknown>;
  const font = (entry: { family?: unknown; style?: unknown } | undefined, fallback: string) => ({
    family: text(entry?.family, 120) ?? fallback,
    style: text(entry?.style, 40) ?? "normal",
  });
  const parts: VisualPart[] = candidate.parts.slice(0, 200).flatMap((raw) => {
    const part = (raw ?? {}) as Record<string, unknown>;
    const id = text(part.id, 64);
    const pageId = text(part.pageId, 64);
    if (!id || !pageId) {
      return [];
    }
    const variant = (part.variant ?? {}) as Record<string, unknown>;
    const side = variant.side === undefined ? undefined : oneOf(variant.side, ["left", "right", "top"] as const, "top");
    const arrange = variant.arrange === undefined ? undefined : oneOf(variant.arrange, ["list", "row", "grid"] as const, "list");
    return [{
      id,
      pageId,
      block: oneOf(part.block, VISUAL_BLOCK_TYPES, "points"),
      variant: {
        align: oneOf(variant.align, ["left", "center", "right"] as const, "left"),
        accent: oneOf(variant.accent, ["plain", "tint", "bold"] as const, "plain"),
        ...(side ? { side } : {}),
        ...(arrange ? { arrange } : {}),
      },
      slots: cleanSlots(part.slots),
    }];
  });
  return {
    theme: {
      id: text(theme.id, 64) ?? "custom",
      name: text(theme.name, 120) ?? "Theme",
      fonts: { heading: font(fonts.heading, "Inter"), body: font(fonts.body, "Inter") },
      colors: {
        background: color(colors.background, "#ffffff"),
        surface: color(colors.surface, "#f1f3f6"),
        primary: color(colors.primary, "#2f5bea"),
        onPrimary: color(colors.onPrimary, "#ffffff"),
        text: color(colors.text, "#16181d"),
        muted: color(colors.muted, "#5d6470"),
      },
      radius: typeof theme.radius === "number" && theme.radius >= 0 && theme.radius <= 200 ? theme.radius : 16,
    },
    parts,
    markdown: text(candidate.markdown, 400_000) ?? "",
    generatedAt: text(candidate.generatedAt, 40) ?? new Date().toISOString(),
  };
}
