import { type BlockItem, type BlockSlots, type BlockVariant, type VisualBlockType } from "@mycanvas/shared";

/*
 * What each visual block holds and how much. Character limits are for a
 * square or 4:5 carousel page; the renderer still shrinks text that runs
 * over, so they guide the AI rather than cut anyone's words.
 */

export type TextSlot = "kicker" | "title" | "subtitle" | "text" | "number" | "author" | "role" | "action" | "handle";

export interface Limit {
  max: number;
  required?: boolean;
}

export interface BlockSpec {
  type: VisualBlockType;
  label: string;
  /** For people (and the AI): what the block is for. */
  description: string;
  text: Partial<Record<TextSlot, Limit>>;
  items?: { min: number; max: number; fields: Partial<Record<keyof BlockItem, Limit>> };
  compare?: { label: number; min: number; max: number; item: number };
  /** Whether the block can show a picture. */
  picture?: "optional" | "main";
  sides?: NonNullable<BlockVariant["side"]>[];
  arranges?: NonNullable<BlockVariant["arrange"]>[];
  /** Alignments that make sense (all three unless listed). */
  aligns?: BlockVariant["align"][];
  defaults: BlockVariant;
}

export const BLOCKS: Record<VisualBlockType, BlockSpec> = {
  cover: {
    type: "cover",
    label: "Cover",
    description: "First page: the topic's title, a short promise, optional kicker above and author",
    text: { kicker: { max: 24 }, title: { max: 50, required: true }, subtitle: { max: 90 }, author: { max: 30 } },
    picture: "optional",
    sides: ["top", "right", "left"],
    defaults: { align: "left", accent: "bold", side: "top" },
  },
  statement: {
    type: "statement",
    label: "Statement",
    description: "One strong sentence on its own: a key message or conclusion",
    text: { kicker: { max: 24 }, text: { max: 110, required: true } },
    defaults: { align: "left", accent: "plain" },
  },
  section: {
    type: "section",
    label: "Section",
    description: "Opens a new part of the content: optional number, a short title and subtitle",
    text: { number: { max: 3 }, title: { max: 36, required: true }, subtitle: { max: 60 } },
    defaults: { align: "left", accent: "tint" },
  },
  points: {
    type: "points",
    label: "Points",
    description: "A title and 3 to 5 short points that don't follow an order",
    text: { title: { max: 40, required: true } },
    items: { min: 2, max: 5, fields: { text: { max: 70, required: true } } },
    defaults: { align: "left", accent: "plain" },
  },
  steps: {
    type: "steps",
    label: "Steps",
    description: "A process in order: 3 to 5 numbered steps, each a short label and a sentence",
    text: { title: { max: 40, required: true } },
    items: { min: 2, max: 5, fields: { label: { max: 22, required: true }, text: { max: 70 } } },
    arranges: ["list", "grid"],
    defaults: { align: "left", accent: "plain", arrange: "list" },
  },
  cards: {
    type: "cards",
    label: "Cards",
    description: "2 to 4 parallel ideas of equal weight (options, benefits, pillars), each a label and a sentence",
    text: { title: { max: 40, required: true } },
    items: { min: 2, max: 4, fields: { label: { max: 20, required: true }, text: { max: 60 } } },
    arranges: ["grid", "list", "row"],
    defaults: { align: "left", accent: "plain", arrange: "grid" },
  },
  stats: {
    type: "stats",
    label: "Big numbers",
    description: "1 to 3 figures that matter, each a short value (72%, 3x, 1.200) and what it measures. Only numbers that are in the content",
    text: { title: { max: 40 } },
    items: { min: 1, max: 3, fields: { value: { max: 7, required: true }, label: { max: 40, required: true } } },
    arranges: ["list", "row"],
    defaults: { align: "left", accent: "plain", arrange: "list" },
  },
  compare: {
    type: "compare",
    label: "Compare",
    description: "Two sides next to each other: before/after, pros/cons, myth/fact, each with a label and 2 to 4 points",
    text: { title: { max: 40 } },
    compare: { label: 16, min: 1, max: 4, item: 40 },
    aligns: ["left", "center"],
    defaults: { align: "left", accent: "plain" },
  },
  quote: {
    type: "quote",
    label: "Quote",
    description: "Words someone said or wrote, with who said them",
    text: { text: { max: 160, required: true }, author: { max: 30 }, role: { max: 40 } },
    picture: "optional",
    sides: ["left", "right", "top"],
    defaults: { align: "left", accent: "tint", side: "left" },
  },
  pictureText: {
    type: "pictureText",
    label: "Picture + text",
    description: "An idea best shown with a picture: a title and a short paragraph next to it",
    text: { title: { max: 40, required: true }, text: { max: 160 } },
    picture: "main",
    sides: ["top", "left", "right"],
    defaults: { align: "left", accent: "plain", side: "top" },
  },
  timeline: {
    type: "timeline",
    label: "Timeline",
    description: "Events in time order: 3 to 5 dates or periods, each with a label and optional sentence",
    text: { title: { max: 40, required: true } },
    items: { min: 2, max: 5, fields: { when: { max: 12, required: true }, label: { max: 24, required: true }, text: { max: 60 } } },
    arranges: ["list", "row"],
    aligns: ["left"],
    defaults: { align: "left", accent: "plain", arrange: "list" },
  },
  closing: {
    type: "closing",
    label: "Closing",
    description: "Last page: a wrap-up title, a sentence, and an action for the reader (save, follow, write to us)",
    text: { title: { max: 40, required: true }, text: { max: 90 }, action: { max: 24 }, handle: { max: 30 } },
    defaults: { align: "center", accent: "bold" },
  },
};

export const BLOCK_LIST = Object.values(BLOCKS);

const TEXT_SLOTS: TextSlot[] = ["kicker", "title", "subtitle", "text", "number", "author", "role", "action", "handle"];

/** Problems with a part's slots, worded for the AI to fix (empty = fine). */
export function slotProblems(type: VisualBlockType, slots: BlockSlots): string[] {
  const spec = BLOCKS[type];
  const problems: string[] = [];
  for (const slot of TEXT_SLOTS) {
    const limit = spec.text[slot];
    const value = slots[slot]?.trim() ?? "";
    if (!limit) {
      continue;
    }
    if (limit.required && value === "") {
      problems.push(`"${slot}" is required`);
    } else if (value.length > limit.max) {
      problems.push(`"${slot}" has ${String(value.length)} characters; at most ${String(limit.max)}`);
    }
  }
  if (spec.items) {
    const items = slots.items ?? [];
    if (items.length < spec.items.min || items.length > spec.items.max) {
      problems.push(`"items" needs ${String(spec.items.min)} to ${String(spec.items.max)} entries, has ${String(items.length)}`);
    }
    items.forEach((item, index) => {
      for (const [field, limit] of Object.entries(spec.items?.fields ?? {}) as [keyof BlockItem, Limit][]) {
        const value = item[field]?.trim() ?? "";
        if (limit.required && value === "") {
          problems.push(`items[${String(index)}].${field} is required`);
        } else if (value.length > limit.max) {
          problems.push(`items[${String(index)}].${field} has ${String(value.length)} characters; at most ${String(limit.max)}`);
        }
      }
    });
  }
  if (spec.compare) {
    for (const side of ["left", "right"] as const) {
      const entry = slots[side];
      if (!entry || entry.label.trim() === "") {
        problems.push(`"${side}.label" is required`);
        continue;
      }
      if (entry.label.length > spec.compare.label) {
        problems.push(`"${side}.label" has ${String(entry.label.length)} characters; at most ${String(spec.compare.label)}`);
      }
      if (entry.items.length < spec.compare.min || entry.items.length > spec.compare.max) {
        problems.push(`"${side}.items" needs ${String(spec.compare.min)} to ${String(spec.compare.max)} entries`);
      }
      entry.items.forEach((item, index) => {
        if (item.length > (spec.compare?.item ?? 40)) {
          problems.push(`${side}.items[${String(index)}] has ${String(item.length)} characters; at most ${String(spec.compare?.item ?? 40)}`);
        }
      });
    }
  }
  return problems;
}

/** The slots this block uses, dropping the rest (e.g. after an AI answer). */
export function keepUsedSlots(type: VisualBlockType, slots: BlockSlots): BlockSlots {
  const spec = BLOCKS[type];
  const out: BlockSlots = {};
  for (const slot of TEXT_SLOTS) {
    const value = slots[slot]?.trim();
    if (spec.text[slot] && value) {
      out[slot] = value;
    }
  }
  if (spec.items) {
    const fields = Object.keys(spec.items.fields) as (keyof BlockItem)[];
    out.items = (slots.items ?? []).map((item) => {
      const kept: BlockItem = {};
      for (const field of fields) {
        const value = item[field]?.trim();
        if (value) {
          kept[field] = value;
        }
      }
      return kept;
    }).filter((item) => Object.keys(item).length > 0);
  }
  if (spec.compare) {
    for (const side of ["left", "right"] as const) {
      const entry = slots[side];
      if (entry) {
        out[side] = { label: entry.label.trim(), items: entry.items.map((item) => item.trim()).filter(Boolean) };
      }
    }
  }
  if (spec.picture) {
    if (slots.image) {
      out.image = slots.image;
    }
    if (slots.imageQuery) {
      out.imageQuery = slots.imageQuery;
    }
  }
  return out;
}

/** A variant valid for the block: unknown options fall back to its defaults. */
export function variantFor(type: VisualBlockType, wanted?: Partial<BlockVariant>): BlockVariant {
  const spec = BLOCKS[type];
  const aligns = spec.aligns ?? ["left", "center", "right"];
  const variant: BlockVariant = {
    align: wanted?.align && aligns.includes(wanted.align) ? wanted.align : spec.defaults.align,
    accent: wanted?.accent ?? spec.defaults.accent,
  };
  if (spec.sides) {
    variant.side = wanted?.side && spec.sides.includes(wanted.side) ? wanted.side : spec.defaults.side;
  }
  if (spec.arranges) {
    variant.arrange = wanted?.arrange && spec.arranges.includes(wanted.arrange) ? wanted.arrange : spec.defaults.arrange;
  }
  return variant;
}

/** Every piece of text in the slots, in reading order (for converting between blocks). */
function textPool(slots: BlockSlots): string[] {
  const pool: string[] = [];
  for (const slot of ["kicker", "title", "subtitle", "text", "author", "role", "action", "handle"] as const) {
    const value = slots[slot];
    if (value) {
      pool.push(value);
    }
  }
  return pool;
}

/** Items from whatever list the slots hold (items, or both compare sides). */
function itemsOf(slots: BlockSlots): BlockItem[] {
  if (slots.items && slots.items.length > 0) {
    return slots.items;
  }
  const sides = [slots.left, slots.right].filter((side): side is NonNullable<typeof side> => side !== undefined);
  return sides.flatMap((side) => side.items.map((item) => ({ label: side.label, text: item })));
}

/** "Label: sentence" → both parts; otherwise the text alone. */
function splitLabel(text: string): BlockItem {
  const match = /^(.{2,40}?)[:—–]\s+(.+)$/s.exec(text);
  return match ? { label: match[1]?.trim(), text: match[2]?.trim() } : { text };
}

/**
 * The same content in another block: lists stay lists (labels and sentences
 * kept), text moves to the closest slot. Nothing is dropped silently: text
 * the new block has no slot for is reported back.
 */
export function convertSlots(from: BlockSlots, to: VisualBlockType): { slots: BlockSlots; leftOver: string[] } {
  const spec = BLOCKS[to];
  const slots: BlockSlots = {};
  const items = itemsOf(from).map((item) => ({ ...item }));
  const pool = textPool(from);
  const title = from.title ?? from.text;
  const leftOver: string[] = [];

  if (spec.items) {
    slots.title = from.title ?? (from.left && from.right ? `${from.left.label} / ${from.right.label}` : undefined);
    const fields = spec.items.fields;
    slots.items = items.map((item) => {
      const next: BlockItem = { ...item };
      if (fields.label?.required && !next.label && next.text) {
        Object.assign(next, splitLabel(next.text));
        if (!next.label) {
          next.label = next.text;
          delete next.text;
        }
      }
      if (!fields.label && next.label) {
        next.text = next.text ? `${next.label}: ${next.text}` : next.label;
        delete next.label;
      }
      if (fields.when && !next.when) {
        next.when = next.value ?? "";
      }
      if (fields.value && !next.value) {
        next.value = next.when ?? "";
      }
      return next;
    });
    if (slots.items.length === 0 && from.text) {
      slots.items = from.text.split(/(?<=[.!?])\s+/).filter(Boolean).map((sentence) => (fields.label?.required ? splitLabel(sentence) : { text: sentence }));
    }
  } else if (spec.compare) {
    slots.title = from.title;
    const half = Math.ceil(items.length / 2);
    const label = (list: BlockItem[], fallback: string) => list[0]?.label ?? fallback;
    slots.left = { label: label(items.slice(0, half), "A"), items: items.slice(0, half).map((item) => item.text ?? item.label ?? "") };
    slots.right = { label: label(items.slice(half), "B"), items: items.slice(half).map((item) => item.text ?? item.label ?? "") };
  } else {
    const listText = items.map((item) => [item.value ?? item.when, item.label, item.text].filter(Boolean).join(" — "));
    if (spec.text.title) {
      slots.title = title;
    }
    if (spec.text.text) {
      // The sentence goes to text; with a title slot too, keep both apart.
      slots.text = spec.text.title ? (from.title ? from.text ?? from.subtitle : undefined) : (from.text ?? from.title);
      if (!slots.text && listText.length > 0) {
        slots.text = listText.join(". ");
      }
    }
    for (const slot of ["kicker", "subtitle", "number", "author", "role", "action", "handle"] as const) {
      if (spec.text[slot] && from[slot]) {
        slots[slot] = from[slot];
      }
    }
    if (spec.text.subtitle && !slots.subtitle && from.text && slots.title !== from.text) {
      slots.subtitle = from.text;
    }
    if (!spec.text.text && listText.length > 0) {
      leftOver.push(...listText);
    }
  }
  if (spec.picture) {
    slots.image = from.image;
    slots.imageQuery = from.imageQuery;
  }
  const kept = keepUsedSlots(to, slots);
  const used = JSON.stringify(kept);
  for (const piece of pool) {
    if (!used.includes(JSON.stringify(piece).slice(1, -1)) && !leftOver.includes(piece)) {
      leftOver.push(piece);
    }
  }
  return { slots: kept, leftOver };
}
