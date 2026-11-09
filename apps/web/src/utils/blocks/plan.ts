import { type BlockItem, type BlockVariant, type VisualBlockType, VISUAL_BLOCK_TYPES, cleanSlots } from "@mycanvas/shared";
import { BLOCKS, convertSlots, keepUsedSlots, slotProblems, variantFor } from "./catalog";
import { type PlannedPart } from "./rules";

/*
 * Turning a (possibly wrong) plan into one every block can draw: unknown
 * blocks fall back, long lists split over pages, too-short lists become a
 * simpler block, missing titles borrow text. Words are never cut here; the
 * renderer shrinks text that runs long, and the dialog says where.
 */

export interface RepairedPart extends PlannedPart {
  variant: BlockVariant;
  /** Limits still broken after repair (text drawn smaller, usually). */
  problems: string[];
}

/** Reads one planned part from untrusted JSON (the AI's answer). */
export function readPlannedPart(value: unknown, images: Set<string>): PlannedPart | null {
  const raw = (value ?? {}) as { block?: unknown; slots?: unknown };
  const block = VISUAL_BLOCK_TYPES.find((type) => type === raw.block);
  if (!block) {
    return null;
  }
  const slots = keepUsedSlots(block, cleanSlots(raw.slots));
  // Only pictures that are in the content: the model can't invent file names.
  if (slots.image && !images.has(slots.image.replace(/^\/?assets\//, ""))) {
    delete slots.image;
  } else if (slots.image) {
    slots.image = slots.image.replace(/^\/?assets\//, "");
  }
  return { block, slots };
}

function splitItems(part: PlannedPart): PlannedPart[] {
  const spec = BLOCKS[part.block].items;
  const items = part.slots.items ?? [];
  if (!spec || items.length <= spec.max) {
    return [part];
  }
  const count = Math.ceil(items.length / spec.max);
  const size = Math.ceil(items.length / count);
  const out: PlannedPart[] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push({ block: part.block, slots: { ...part.slots, items: items.slice(start, start + size) } });
  }
  return out;
}

function repairOne(part: PlannedPart): PlannedPart[] {
  const spec = BLOCKS[part.block];
  let current: PlannedPart = { block: part.block, slots: keepUsedSlots(part.block, part.slots) };
  const items = current.slots.items ?? [];

  // Too few items for a list block: one item reads better as a statement.
  if (spec.items && items.length < spec.items.min) {
    if (items.length === 0 && !current.slots.title) {
      return [];
    }
    const only = items[0];
    const text = only ? [only.value ?? only.when, only.label, only.text].filter(Boolean).join(" — ") : undefined;
    current = { block: "statement", slots: { kicker: current.slots.title, text: text ?? current.slots.title } };
    if (!text) {
      current = { block: "section", slots: { title: part.slots.title } };
    }
  }
  // Stats need a value on every item; otherwise they are points.
  if (current.block === "stats" && (current.slots.items ?? []).some((item: BlockItem) => !item.value)) {
    current = { block: "points", slots: convertSlots(current.slots, "points").slots };
  }
  // Compare needs both sides.
  if (current.block === "compare" && (!current.slots.left?.items.length || !current.slots.right?.items.length)) {
    current = { block: "points", slots: convertSlots(current.slots, "points").slots };
  }
  // A required title: borrow a kicker or subtitle, never an item's own text
  // (it would show twice). A page without a title still draws fine.
  const title = BLOCKS[current.block].text.title;
  if (title?.required && !current.slots.title) {
    current.slots.title = current.slots.kicker ?? current.slots.subtitle ?? "";
    if (!current.slots.title) {
      delete current.slots.title;
    }
  }
  const requiredText = BLOCKS[current.block].text.text;
  if (requiredText?.required && !current.slots.text) {
    current.slots.text = current.slots.title ?? current.slots.subtitle ?? "";
  }
  return splitItems(current);
}

/** Variants that give a carousel rhythm: bold cover and closing, tinted sections, a change of pace between lists. */
function rhythm(parts: PlannedPart[]): BlockVariant[] {
  let statements = 0;
  return parts.map((part) => {
    const variant = variantFor(part.block);
    if (part.block === "statement") {
      variant.accent = statements % 2 === 0 ? "tint" : "bold";
      statements += 1;
    }
    return variant;
  });
}

export function repairPlan(parts: PlannedPart[]): RepairedPart[] {
  const repaired = parts.flatMap(repairOne);
  const variants = rhythm(repaired);
  return repaired.map((part, index) => ({
    ...part,
    variant: variants[index] ?? variantFor(part.block),
    problems: slotProblems(part.block, part.slots).filter((problem) => !problem.includes("is required")),
  }));
}

/** Block types a part can switch to and keep its content readable. */
export function compatibleBlocks(block: VisualBlockType): VisualBlockType[] {
  const lists: VisualBlockType[] = ["points", "steps", "cards", "timeline", "stats", "compare"];
  const texts: VisualBlockType[] = ["statement", "quote", "section", "cover", "closing", "pictureText"];
  return lists.includes(block) ? [...lists, "statement"] : [...texts, "points"];
}
