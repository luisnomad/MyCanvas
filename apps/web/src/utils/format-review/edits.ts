import { type BlockKind, type DesignPage, type Layer } from "@mycanvas/shared";
import { type Rect } from "./measure";

/*
 * The small, fixed set of changes the AI review may suggest. The model never
 * writes layers itself: it names one of these with a layer's short id (L1,
 * L2…) and rough positions on a 0–1000 grid; the review code checks and
 * measures each one, then turns it into an exact Change.
 */

export type TextBlockKind = Exclude<BlockKind, "image">;
const TEXT_KINDS: TextBlockKind[] = ["title", "lead", "heading", "body", "callout"];

export type ReviewEdit =
  | { op: "style"; layer: string; color?: string; size?: number; weight?: number; why: string }
  | { op: "move"; layer: string; x: number; y: number; why: string }
  | { op: "role"; layer: string; block: TextBlockKind; why: string }
  | { op: "box"; layer: string; why: string }
  | { op: "callout"; x: number; y: number; text: string; why: string }
  | { op: "remove"; layer: string; why: string }
  | { op: "flow"; top?: number; bottom?: number; left?: number; right?: number; why: string };

/** One row of the layer list the model sees. */
export interface TableRow {
  short: string;
  layer: Layer;
  /** Where it is drawn, design px. */
  box: Rect;
}

/** Exact changes to one page, applied together as one undo step. */
export interface Change {
  patches: { id: string; patch: Partial<Layer> }[];
  /** New layers, placed just before `before` (or before the reference layer, or on top). */
  add: { layers: Layer[]; before: string | null }[];
  remove: string[];
}

export const EMPTY_CHANGE: Change = { patches: [], add: [], remove: [] };

const grid = (value: number, size: number) => Math.round((value / size) * 1000);

function roleLabel(layer: Layer): string {
  const role = layer.formatRole;
  if (!role) {
    return layer.locked ? "decoration (locked)" : "decoration";
  }
  return role.kind === "sample" || role.kind === "box" ? `${role.kind}:${role.block}` : role.kind;
}

/** The layer list for the prompt: short id, kind, role, position, look. */
export function describeRows(rows: TableRow[], width: number, height: number): string {
  return rows.map(({ short, layer, box }) => {
    const where = `box=[${String(grid(box.x, width))},${String(grid(box.y, height))},${String(grid(box.width, width))},${String(grid(box.height, height))}]`;
    if (layer.type === "text") {
      const text = layer.text.replace(/\s+/g, " ").slice(0, 70);
      return `${short} text "${text}" role=${roleLabel(layer)} ${where} font="${layer.fontFamily}" style=${layer.fontStyle} size=${String(Math.round(layer.fontSize))} color=${layer.fill}`;
    }
    if (layer.type === "rect") {
      return `${short} rectangle role=${roleLabel(layer)} ${where} fill=${layer.fill}`;
    }
    return `${short} ${layer.type} "${layer.name}" role=${roleLabel(layer)} ${where}`;
  }).join("\n");
}

function num(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** The model's answer as JSON, even when it wrapped it in prose. */
export function parseJsonAnswer(answer: string): unknown {
  try {
    return JSON.parse(answer);
  } catch {
    const match = /\{[\s\S]*\}/.exec(answer);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Checks the model's edits against the layer list. Anything malformed, or
 * aimed at a layer it can't change that way, is dropped.
 */
export function parseEdits(answer: string, rows: TableRow[]): { edits: ReviewEdit[]; rejected: number } {
  const parsed = parseJsonAnswer(answer) as { edits?: unknown } | unknown[] | null;
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.edits) ? parsed.edits as unknown[] : [];
  const byShort = new Map(rows.map((row) => [row.short.toUpperCase(), row]));
  const find = (value: unknown) => byShort.get((typeof value === "number" ? `L${String(value)}` : String(value)).trim().toUpperCase());
  const edits: ReviewEdit[] = [];
  let rejected = 0;
  for (const item of list.slice(0, 16)) {
    const raw = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const why = text(raw.why, 200);
    const row = find(raw.layer);
    const layer = row?.layer;
    const role = layer?.formatRole;
    const isSample = role?.kind === "sample" && role.block !== "image";
    let edit: ReviewEdit | null = null;
    switch (raw.op) {
      case "style": {
        const color = typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color.trim()) ? raw.color.trim().toLowerCase() : undefined;
        const size = num(raw.size, 4, 400);
        const weightValue = num(raw.weight, 100, 900);
        const weight = weightValue === undefined ? undefined : Math.round(weightValue / 100) * 100;
        if (row && layer?.type === "text" && (color ?? size ?? weight) !== undefined) {
          edit = { op: "style", layer: row.short, ...(color ? { color } : {}), ...(size ? { size } : {}), ...(weight ? { weight } : {}), why };
        }
        break;
      }
      case "move": {
        const x = num(raw.x, 0, 1000);
        const y = num(raw.y, 0, 1000);
        if (row && layer && !layer.locked && (layer.type === "text" || role?.kind === "sample") && x !== undefined && y !== undefined) {
          edit = { op: "move", layer: row.short, x, y, why };
        }
        break;
      }
      case "role": {
        const block = TEXT_KINDS.find((kind) => kind === raw.block);
        if (row && isSample && block && role.block !== block) {
          edit = { op: "role", layer: row.short, block, why };
        }
        break;
      }
      case "box":
        if (row && layer?.type === "text" && isSample) {
          edit = { op: "box", layer: row.short, why };
        }
        break;
      case "callout": {
        const x = num(raw.x, 0, 1000);
        const y = num(raw.y, 0, 1000);
        const words = text(raw.text, 300);
        if (x !== undefined && y !== undefined && words) {
          edit = { op: "callout", x, y, text: words, why };
        }
        break;
      }
      case "remove":
        if (row && layer?.type === "text" && !role) {
          edit = { op: "remove", layer: row.short, why };
        }
        break;
      case "flow": {
        const sides = {
          top: num(raw.top, 0, 1000),
          bottom: num(raw.bottom, 0, 1000),
          left: num(raw.left, 0, 1000),
          right: num(raw.right, 0, 1000),
        };
        const given = Object.fromEntries(Object.entries(sides).filter(([, value]) => value !== undefined));
        if (rows.some((entry) => entry.layer.formatRole?.kind === "flow") && Object.keys(given).length > 0) {
          edit = { op: "flow", ...given, why };
        }
        break;
      }
      default:
        break;
    }
    if (edit) {
      edits.push(edit);
    } else {
      rejected++;
    }
  }
  return { edits, rejected };
}

/** Applies accepted changes to one page's layers. */
export function applyChanges(pages: DesignPage[], pageId: string, changes: Change[]): DesignPage[] {
  return pages.map((page) => {
    if (page.id !== pageId) {
      return page;
    }
    const removed = new Set(changes.flatMap((change) => change.remove));
    const patches = new Map<string, Record<string, unknown>>();
    for (const { id, patch } of changes.flatMap((change) => change.patches)) {
      patches.set(id, { ...patches.get(id), ...patch });
    }
    let layers: Layer[] = page.layers
      .filter((layer) => !removed.has(layer.id))
      .map((layer) => {
        const patch = patches.get(layer.id);
        return patch ? { ...layer, ...patch } : layer;
      });
    for (const { layers: added, before } of changes.flatMap((change) => change.add)) {
      let index = before ? layers.findIndex((layer) => layer.id === before) : -1;
      if (index < 0) {
        index = layers.findIndex((layer) => layer.formatRole?.kind === "reference");
      }
      layers = index < 0 ? [...layers, ...added] : [...layers.slice(0, index), ...added, ...layers.slice(index)];
    }
    return { ...page, layers };
  });
}
