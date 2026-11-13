import {
  type Design,
  type DesignPage,
  type FrameContent,
  type FrameLayer,
  type GradientFill,
  type ImageLayer,
  type Layer,
  type TextEffect,
  SHAPE_NAMES,
  defaultShadow,
  defaultStroke,
  defaultTextEffect,
  coverContent,
  frameContentBox,
  newLayer,
  recoverContent,
} from "@mycanvas/shared";

/*
 * Batched page and layer edits for the agent API (POST …/ops). A batch is
 * applied to a copy of the design and either all of it succeeds or nothing
 * changes. Input is validated field by field: unknown fields, wrong types
 * and type changes are refused with a message saying which op and field.
 */

export class OpError extends Error {}

type Position = "top" | "bottom" | number | { above: string } | { below: string };
type PageRef = number | string;

export type Op =
  | { op: "addLayer"; page?: PageRef; layer: Record<string, unknown>; at?: Position }
  | { op: "updateLayer"; page?: PageRef; id: string; set: Record<string, unknown> }
  | { op: "deleteLayer"; page?: PageRef; id: string }
  | { op: "moveLayer"; page?: PageRef; id: string; to: Position }
  | { op: "addPage"; after?: PageRef; background?: string; copyOf?: PageRef }
  | { op: "updatePage"; page: PageRef; background?: string; backgroundGradient?: GradientFill | null }
  | { op: "deletePage"; page: PageRef }
  | { op: "movePage"; page: PageRef; to: number };

export interface OpsContext {
  /** Pixel size of an upload, or null when it doesn't exist. */
  assetSize: (asset: string) => { width: number; height: number } | null;
  newId: () => string;
}

export interface OpsResult {
  design: Design;
  /** Ids of the layers and pages added, in op order. */
  created: string[];
}

const MAX_OPS = 500;

/** Uploads a batch refers to, so their sizes can be read before applying it. */
export function assetsIn(ops: unknown): string[] {
  const found = new Set<string>();
  if (!Array.isArray(ops)) {
    return [];
  }
  for (const op of ops as Record<string, unknown>[]) {
    const fields = (op.layer ?? op.set) as Record<string, unknown> | undefined;
    if (typeof fields?.asset === "string") {
      found.add(fields.asset);
    }
    const content = fields?.content as Record<string, unknown> | undefined;
    if (typeof content?.asset === "string") {
      found.add(content.asset);
    }
  }
  return [...found];
}

// ---------------------------------------------------------------- validation

type Check = (value: unknown, field: string) => unknown;

function fail(field: string, message: string): never {
  throw new OpError(`${field}: ${message}`);
}

const num: Check = (v, f) => (typeof v === "number" && Number.isFinite(v) ? v : fail(f, "must be a number"));
const pos: Check = (v, f) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fail(f, "must be a positive number"));
const nonNeg: Check = (v, f) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fail(f, "must be 0 or more"));
const unit: Check = (v, f) => (typeof v === "number" && v >= 0 && v <= 1 ? v : fail(f, "must be between 0 and 1"));
const bool: Check = (v, f) => (typeof v === "boolean" ? v : fail(f, "must be true or false"));
const str: Check = (v, f) => (typeof v === "string" ? v : fail(f, "must be a string"));
const nonEmpty: Check = (v, f) => (typeof v === "string" && v.trim() !== "" ? v : fail(f, "must be a non-empty string"));
const color: Check = (v, f) =>
  typeof v === "string" && /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|transparent)$/.test(v.trim()) ? v.trim() : fail(f, "must be a color like #ff8800");
const range = (min: number, max: number): Check => (v, f) =>
  typeof v === "number" && v >= min && v <= max ? v : fail(f, `must be between ${String(min)} and ${String(max)}`);
const oneOf = (...values: string[]): Check => (v, f) =>
  typeof v === "string" && values.includes(v) ? v : fail(f, `must be one of ${values.join(", ")}`);
const optional = (check: Check): Check => (v, f) => (v === undefined ? undefined : check(v, f));
const fontStyle: Check = (v, f) =>
  typeof v === "string" && /^(normal|((italic|bold|[1-9]00)( (italic|bold|[1-9]00))*))$/.test(v.trim())
    ? v.trim()
    : fail(f, "must be \"normal\", \"bold\", \"italic\", a weight like \"800\", or e.g. \"italic 300\"");

function object(fields: Record<string, Check>, defaults: () => Record<string, unknown> = () => ({})): Check {
  return (v, f) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      fail(f, "must be an object");
    }
    const out: Record<string, unknown> = defaults();
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      const check = fields[key];
      if (!check) {
        fail(`${f}.${key}`, "unknown field");
      }
      const checked = check(value, `${f}.${key}`);
      if (checked !== undefined) {
        out[key] = checked;
      }
    }
    for (const key of Object.keys(fields)) {
      if (out[key] === undefined && fields[key] !== undefined && !isOptional(fields[key])) {
        fail(`${f}.${key}`, "is required");
      }
    }
    return out;
  };
}

const optionalChecks = new WeakSet<Check>();
function opt(check: Check): Check {
  const wrapped = optional(check);
  optionalChecks.add(wrapped);
  return wrapped;
}
function isOptional(check: Check | undefined): boolean {
  return check !== undefined && optionalChecks.has(check);
}

const shadow = object(
  { enabled: opt(bool), color: opt(color), blur: opt(nonNeg), offsetX: opt(num), offsetY: opt(num), opacity: opt(unit) },
  () => ({ ...defaultShadow() }),
);
const stroke = object({ enabled: opt(bool), color: opt(color), width: opt(nonNeg) }, () => ({ ...defaultStroke() }));

const gradient: Check = (v, f) => {
  const g = object({ type: oneOf("linear", "radial"), angle: opt(num), stops: (s) => s }, () => ({ angle: 0 }))(v, f) as GradientFill;
  if (!Array.isArray(g.stops) || g.stops.length < 2) {
    fail(`${f}.stops`, "needs at least 2 stops");
  }
  g.stops = g.stops.map((stop, index) =>
    object({ offset: unit, color })(stop, `${f}.stops[${String(index)}]`) as GradientFill["stops"][number]);
  return g;
};

const EFFECT_FIELDS: Record<TextEffect["type"], Record<string, Check>> = {
  none: {},
  shadow: { color: opt(color), distance: opt(nonNeg), angle: opt(range(-180, 180)), blur: opt(nonNeg), opacity: opt(unit) },
  glow: { color: opt(color), spread: opt(nonNeg), strength: opt(range(0, 100)), blur: opt(nonNeg) },
  outline: { color: opt(color), thickness: opt(nonNeg) },
  echo: { color: opt(color), distance: opt(nonNeg), angle: opt(range(-180, 180)) },
  background: { color: opt(color), spread: opt(nonNeg), roundness: opt(range(0, 100)), opacity: opt(unit) },
  glitch: { colorPair: opt(oneOf("cyan-magenta", "red-blue")), distance: opt(nonNeg), angle: opt(range(-180, 180)) },
};

const effect: Check = (v, f) => {
  const type = (v as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !(type in EFFECT_FIELDS)) {
    fail(`${f}.type`, `must be one of ${Object.keys(EFFECT_FIELDS).join(", ")}`);
  }
  const effectType = type as TextEffect["type"];
  const defaults = () => (effectType === "none" ? { type: "none" } : { ...defaultTextEffect(effectType) });
  return object({ type: str, ...EFFECT_FIELDS[effectType] }, defaults)(v, f);
};

const adjust = object({
  preset: opt(oneOf("none", "mono", "noir", "sepia", "vintage", "warm", "cool", "vivid", "fade")),
  brightness: opt(range(-100, 100)),
  contrast: opt(range(-100, 100)),
  saturation: opt(range(-100, 100)),
  hue: opt(range(-180, 180)),
  blur: opt(range(0, 50)),
});
const crop = object({ x: nonNeg, y: nonNeg, width: pos, height: pos });
const passthroughObject: Check = (v, f) => (typeof v === "object" && v !== null ? v : fail(f, "must be an object"));
const shapeKind = oneOf("triangle", "hexagon", "circle", "semicircle", "star");

const COMMON: Record<string, Check> = {
  name: nonEmpty,
  x: num,
  y: num,
  scaleX: pos,
  scaleY: pos,
  rotation: num,
  opacity: unit,
  visible: bool,
  groupId: optional(str),
  groupName: (v, f) => (typeof v === "string" && v.trim() !== "" && v.length <= 80 ? v.trim() : fail(f, "must be a name of 1–80 characters")),
  locked: bool,
  formatRole: passthroughObject,
  blockSlot: str,
};

const TYPE_FIELDS: Record<Layer["type"], Record<string, Check>> = {
  text: {
    text: str,
    fontFamily: nonEmpty,
    fontSize: pos,
    fontStyle,
    fill: color,
    align: oneOf("left", "center", "right"),
    lineHeight: pos,
    letterSpacing: num,
    wrapWidth: nonNeg,
    curve: range(-100, 100),
    effect,
    shadow,
    stroke,
  },
  image: {
    asset: nonEmpty,
    width: pos,
    height: pos,
    crop,
    cutout: bool,
    behindText: passthroughObject,
    adjust,
    flipX: bool,
    flipY: bool,
    shadow,
  },
  rect: { width: pos, height: pos, fill: color, gradient, cornerRadius: nonNeg, stroke, shadow },
  line: {
    points: (v, f) =>
      Array.isArray(v) && v.length === 4 && (v as unknown[]).every((n) => typeof n === "number" && Number.isFinite(n))
        ? (v as number[])
        : fail(f, "must be [x1, y1, x2, y2]"),
    control: (v, f) =>
      Array.isArray(v) && v.length === 2 && (v as unknown[]).every((n) => typeof n === "number" && Number.isFinite(n))
        ? (v as number[])
        : fail(f, "must be [x, y], the point the curve bends towards"),
    strokeColor: color,
    strokeWidth: pos,
    lineCap: oneOf("butt", "round", "square"),
    shadow,
  },
  shape: { shape: shapeKind, width: pos, height: pos, fill: color, gradient, cornerRadius: nonNeg, stroke, shadow },
  frame: {
    shape: oneOf("rect", "triangle", "hexagon", "circle", "semicircle", "star"),
    width: pos,
    height: pos,
    cornerRadius: nonNeg,
    content: passthroughObject,
    adjust,
    flipX: bool,
    flipY: bool,
    contentRotation: num,
  },
};

/** Fields that may be set to null to remove them. */
const CLEARABLE = new Set(["groupId", "gradient", "crop", "adjust", "content", "behindText", "formatRole", "blockSlot", "curve", "cornerRadius", "contentRotation", "control", "groupName"]);

function checkFields(type: Layer["type"], input: Record<string, unknown>, where: string, extras: string[] = []): Record<string, unknown> {
  const fields = { ...COMMON, ...TYPE_FIELDS[type] };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "type" || key === "id" || extras.includes(key)) {
      continue;
    }
    const check = fields[key];
    if (!check) {
      fail(`${where}.${key}`, `unknown field for a ${type} layer`);
    }
    if (value === null && CLEARABLE.has(key)) {
      out[key] = null;
      continue;
    }
    out[key] = check(value, `${where}.${key}`);
  }
  return out;
}

function applyFields(layer: Layer, fields: Record<string, unknown>): Layer {
  const next = { ...layer } as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next as unknown as Layer;
}

// ---------------------------------------------------------------- geometry

function checkFrameContent(value: unknown, where: string, layer: FrameLayer, ctx: OpsContext): FrameContent {
  const content = value as Record<string, unknown>;
  const asset = nonEmpty(content.asset, `${where}.asset`) as string;
  const size = ctx.assetSize(asset);
  if (!size) {
    fail(`${where}.asset`, `upload "${asset}" not found`);
  }
  const unknown = Object.keys(content).find((key) => !["asset", "offsetX", "offsetY", "scale"].includes(key));
  if (unknown) {
    fail(`${where}.${unknown}`, "unknown field");
  }
  if (content.scale === undefined) {
    // Placement is in the photo's own box (it differs from the frame's when
    // the photo keeps its angle while the frame is rotated).
    const box = frameContentBox(layer);
    return coverContent(asset, size.width, size.height, box.width, box.height);
  }
  return {
    asset,
    scale: pos(content.scale, `${where}.scale`) as number,
    offsetX: num(content.offsetX ?? 0, `${where}.offsetX`) as number,
    offsetY: num(content.offsetY ?? 0, `${where}.offsetY`) as number,
  };
}

/**
 * The frame's photo after a change to its box (size, rotation while the
 * photo keeps its angle, or turning that setting on or off): zoom and visible
 * center kept, still covering the frame.
 */
function refitContent(before: FrameLayer, after: FrameLayer, content: FrameContent, ctx: OpsContext): FrameContent {
  const oldBox = frameContentBox(before);
  const newBox = frameContentBox(after);
  const size = ctx.assetSize(content.asset);
  if (!size || (oldBox.width === newBox.width && oldBox.height === newBox.height)) {
    return content;
  }
  return recoverContent(content, size.width, size.height, oldBox.width, oldBox.height, newBox.width, newBox.height);
}

/**
 * An image layer from the agent's partial input. Size: given width and
 * height, or one of them (aspect kept), or the picture's own size scaled to
 * fit the canvas. `fit: "cover"` fills the width×height box (cropping);
 * `fit: "contain"` fits inside it, centered.
 */
function buildImageLayer(id: string, input: Record<string, unknown>, where: string, design: Design, ctx: OpsContext): ImageLayer {
  const fields = checkFields("image", input, where, ["fit"]);
  const asset = fields.asset as string | undefined;
  if (asset === undefined) {
    fail(`${where}.asset`, "is required for an image layer");
  }
  const size = ctx.assetSize(asset);
  if (!size) {
    fail(`${where}.asset`, `upload "${asset}" not found`);
  }
  const fit = input.fit === undefined ? undefined : oneOf("cover", "contain")(input.fit, `${where}.fit`);
  const ratio = size.width / size.height;
  let width = fields.width as number | undefined;
  let height = fields.height as number | undefined;
  let x = fields.x as number | undefined;
  let y = fields.y as number | undefined;
  let crop = fields.crop as ImageLayer["crop"] | undefined;
  if (fit !== undefined && (width === undefined || height === undefined)) {
    fail(`${where}.fit`, "needs both width and height (the box to fit into)");
  }
  if (fit === "cover" && width !== undefined && height !== undefined && crop === undefined) {
    // Crop the picture to the box's aspect ratio, centered.
    const boxRatio = width / height;
    const cropW = boxRatio > ratio ? size.width : size.height * boxRatio;
    const cropH = boxRatio > ratio ? size.width / boxRatio : size.height;
    crop = { x: (size.width - cropW) / 2, y: (size.height - cropH) / 2, width: cropW, height: cropH };
  } else if (fit === "contain" && width !== undefined && height !== undefined) {
    const scale = Math.min(width / size.width, height / size.height);
    const fittedW = size.width * scale;
    const fittedH = size.height * scale;
    x = (x ?? 0) + (width - fittedW) / 2;
    y = (y ?? 0) + (height - fittedH) / 2;
    width = fittedW;
    height = fittedH;
  } else if (width !== undefined && height === undefined) {
    height = width / ratio;
  } else if (height !== undefined && width === undefined) {
    width = height * ratio;
  } else if (width === undefined && height === undefined) {
    const scale = Math.min(1, design.width / size.width, design.height / size.height);
    width = size.width * scale;
    height = size.height * scale;
  }
  const w = Math.max(1, Math.round(width ?? 1));
  const h = Math.max(1, Math.round(height ?? 1));
  const layer: ImageLayer = {
    id,
    type: "image",
    name: "Image",
    x: Math.round((design.width - w) / 2),
    y: Math.round((design.height - h) / 2),
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    visible: true,
    asset,
    width: w,
    height: h,
    shadow: defaultShadow(),
  };
  const merged = applyFields(layer, { ...fields, width: w, height: h }) as ImageLayer;
  if (x !== undefined) {
    merged.x = Math.round(x);
  }
  if (y !== undefined) {
    merged.y = Math.round(y);
  }
  if (crop) {
    merged.crop = crop;
  }
  return merged;
}

// ---------------------------------------------------------------- the batch

const LAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function allIds(design: Design): Set<string> {
  return new Set(design.pages.flatMap((page) => page.layers.map((layer) => layer.id)));
}

function pageIndex(design: Design, ref: unknown, where: string): number {
  if (typeof ref === "number" && Number.isInteger(ref) && ref >= 0 && ref < design.pages.length) {
    return ref;
  }
  if (typeof ref === "string") {
    const index = design.pages.findIndex((page) => page.id === ref);
    if (index >= 0) {
      return index;
    }
  }
  return fail(where, `no page ${JSON.stringify(ref)} (the design has ${String(design.pages.length)}; use a 0-based index or a page id)`);
}

/** Finds a layer by id, on the given page or (without one) on any page. */
function findLayer(design: Design, id: unknown, pageRef: unknown, where: string): { page: DesignPage; index: number } {
  if (typeof id !== "string") {
    fail(`${where}.id`, "must be a layer id");
  }
  const pages = pageRef === undefined ? design.pages : [design.pages[pageIndex(design, pageRef, `${where}.page`)]!];
  for (const page of pages) {
    const index = page.layers.findIndex((layer) => layer.id === id);
    if (index >= 0) {
      return { page, index };
    }
  }
  return fail(`${where}.id`, `no layer "${id}"`);
}

/** Index to insert at (0 = bottom) in `layers` (which no longer holds the moved layer). */
function resolvePosition(layers: Layer[], to: unknown, where: string): number {
  if (to === undefined || to === "top") {
    return layers.length;
  }
  if (to === "bottom") {
    return 0;
  }
  if (typeof to === "number" && Number.isInteger(to)) {
    return Math.max(0, Math.min(layers.length, to));
  }
  const ref = typeof to === "object" && to !== null ? (to as { above?: unknown; below?: unknown }) : null;
  const target = ref?.above ?? ref?.below;
  if (typeof target === "string") {
    const index = layers.findIndex((layer) => layer.id === target);
    if (index < 0) {
      fail(where, `no layer "${target}" on this page`);
    }
    return ref?.above !== undefined ? index + 1 : index;
  }
  return fail(where, "must be \"top\", \"bottom\", an index, { above: id } or { below: id }");
}

function clonePage(page: DesignPage, ctx: OpsContext): DesignPage {
  const groups = new Map<string, string>();
  return {
    id: ctx.newId(),
    background: page.background,
    ...(page.backgroundGradient ? { backgroundGradient: structuredClone(page.backgroundGradient) } : {}),
    layers: page.layers.map((layer) => {
      const copy = structuredClone(layer);
      copy.id = ctx.newId();
      if (copy.groupId) {
        let group = groups.get(copy.groupId);
        if (!group) {
          group = ctx.newId();
          groups.set(copy.groupId, group);
        }
        copy.groupId = group;
      }
      return copy;
    }),
  };
}

export function applyOps(source: Design, ops: unknown, ctx: OpsContext): OpsResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new OpError("ops: must be a non-empty array");
  }
  if (ops.length > MAX_OPS) {
    throw new OpError(`ops: at most ${String(MAX_OPS)} per batch`);
  }
  const design = structuredClone(source);
  const ids = allIds(design);
  const created: string[] = [];

  (ops as Record<string, unknown>[]).forEach((op, n) => {
    const where = `ops[${String(n)}]`;
    if (typeof op !== "object" || op === null) {
      fail(where, "must be an object");
    }
    switch (op.op) {
      case "addLayer": {
        const input = op.layer as Record<string, unknown> | undefined;
        if (typeof input !== "object" || input === null) {
          fail(`${where}.layer`, "must be an object");
        }
        const type = input.type;
        if (typeof type !== "string" || !(type in TYPE_FIELDS)) {
          fail(`${where}.layer.type`, `must be one of ${Object.keys(TYPE_FIELDS).join(", ")}`);
        }
        let id: string;
        if (input.id !== undefined) {
          if (typeof input.id !== "string" || !LAYER_ID.test(input.id)) {
            fail(`${where}.layer.id`, "must be 1–64 letters, digits, - or _");
          }
          if (ids.has(input.id)) {
            fail(`${where}.layer.id`, `"${input.id}" is already used in this design`);
          }
          id = input.id;
        } else {
          id = ctx.newId();
        }
        const page = design.pages[pageIndex(design, op.page ?? 0, `${where}.page`)]!;
        let layer: Layer;
        if (type === "image") {
          layer = buildImageLayer(id, input, `${where}.layer`, design, ctx);
        } else {
          const layerType = type as Exclude<Layer["type"], "image">;
          const fields = checkFields(layerType, input, `${where}.layer`);
          layer = applyFields(newLayer(layerType, id, design), fields);
          if (layer.type === "frame" && fields.content) {
            layer.content = checkFrameContent(fields.content, `${where}.layer.content`, layer, ctx);
          }
          // The defaults are a circle; a shape of another kind is named after it.
          if (layer.type === "shape" && typeof input.name !== "string") {
            layer.name = SHAPE_NAMES[layer.shape];
          }
          // A line given only its points is drawn where they say on the page,
          // not offset from the default spot in the middle.
          if (layer.type === "line" && input.points !== undefined) {
            layer.x = typeof input.x === "number" ? input.x : 0;
            layer.y = typeof input.y === "number" ? input.y : 0;
          }
          if (layer.type === "text" && typeof input.name !== "string") {
            layer.name = (layer.text.split("\n")[0]?.slice(0, 40).trim() ?? "") === "" ? "Text" : (layer.text.split("\n")[0] ?? "").slice(0, 40).trim();
          }
        }
        page.layers.splice(resolvePosition(page.layers, op.at, `${where}.at`), 0, layer);
        ids.add(id);
        created.push(id);
        return;
      }
      case "updateLayer": {
        const { page, index } = findLayer(design, op.id, op.page, where);
        const layer = page.layers[index]!;
        const set = op.set as Record<string, unknown> | undefined;
        if (typeof set !== "object" || set === null) {
          fail(`${where}.set`, "must be an object");
        }
        if (set.type !== undefined && set.type !== layer.type) {
          fail(`${where}.set.type`, "a layer's type can't change (delete it and add a new one)");
        }
        if (set.id !== undefined && set.id !== layer.id) {
          fail(`${where}.set.id`, "a layer's id can't change");
        }
        const fields = checkFields(layer.type, set, `${where}.set`);
        let next = applyFields(layer, fields);
        if (next.type === "frame" && fields.content) {
          next = { ...next, content: checkFrameContent(fields.content, `${where}.set.content`, next, ctx) };
        } else if (next.type === "frame" && layer.type === "frame" && next.content && fields.content === undefined) {
          next = { ...next, content: refitContent(layer, next, next.content, ctx) };
        }
        if (next.type === "image" && typeof fields.asset === "string" && !ctx.assetSize(fields.asset)) {
          fail(`${where}.set.asset`, `upload "${fields.asset}" not found`);
        }
        page.layers[index] = next;
        return;
      }
      case "deleteLayer": {
        const { page, index } = findLayer(design, op.id, op.page, where);
        page.layers.splice(index, 1);
        ids.delete(op.id as string);
        return;
      }
      case "moveLayer": {
        const { page, index } = findLayer(design, op.id, op.page, where);
        const [layer] = page.layers.splice(index, 1);
        page.layers.splice(resolvePosition(page.layers, op.to, `${where}.to`), 0, layer!);
        return;
      }
      case "addPage": {
        const after = op.after === undefined ? design.pages.length - 1 : pageIndex(design, op.after, `${where}.after`);
        let page: DesignPage;
        if (op.copyOf !== undefined) {
          page = clonePage(design.pages[pageIndex(design, op.copyOf, `${where}.copyOf`)]!, ctx);
          page.layers.forEach((layer) => ids.add(layer.id));
        } else {
          page = { id: ctx.newId(), background: "#ffffff", layers: [] };
        }
        if (op.background !== undefined) {
          page.background = color(op.background, `${where}.background`) as string;
        }
        design.pages.splice(after + 1, 0, page);
        created.push(page.id);
        return;
      }
      case "updatePage": {
        const page = design.pages[pageIndex(design, op.page, `${where}.page`)]!;
        const unknown = Object.keys(op).find((key) => !["op", "page", "background", "backgroundGradient"].includes(key));
        if (unknown) {
          fail(`${where}.${unknown}`, "unknown field");
        }
        if (op.background !== undefined) {
          page.background = color(op.background, `${where}.background`) as string;
        }
        if (op.backgroundGradient === null) {
          delete page.backgroundGradient;
        } else if (op.backgroundGradient !== undefined) {
          page.backgroundGradient = gradient(op.backgroundGradient, `${where}.backgroundGradient`) as GradientFill;
        }
        // The stored preview no longer matches.
        delete page.thumbnail;
        return;
      }
      case "deletePage": {
        if (design.pages.length === 1) {
          fail(`${where}.page`, "can't delete the only page");
        }
        const index = pageIndex(design, op.page, `${where}.page`);
        design.pages[index]?.layers.forEach((layer) => ids.delete(layer.id));
        design.pages.splice(index, 1);
        return;
      }
      case "movePage": {
        const index = pageIndex(design, op.page, `${where}.page`);
        if (typeof op.to !== "number" || !Number.isInteger(op.to)) {
          fail(`${where}.to`, "must be a page index");
        }
        const [page] = design.pages.splice(index, 1);
        design.pages.splice(Math.max(0, Math.min(design.pages.length, op.to)), 0, page!);
        return;
      }
      case "nameGroup": {
        // Names every member of a group at once (null goes back to "Group N").
        if (typeof op.groupId !== "string" || op.groupId === "") {
          fail(`${where}.groupId`, "must be a group id (a layer's groupId)");
        }
        const name = op.name === null ? null : COMMON.groupName!(op.name, `${where}.name`) as string;
        const pages = op.page === undefined ? design.pages : [design.pages[pageIndex(design, op.page, `${where}.page`)]!];
        let found = 0;
        for (const page of pages) {
          page.layers = page.layers.map((layer) => {
            if (layer.groupId !== op.groupId) {
              return layer;
            }
            found += 1;
            const next = { ...layer };
            if (name === null) {
              delete next.groupName;
            } else {
              next.groupName = name;
            }
            return next;
          });
        }
        if (found === 0) {
          fail(`${where}.groupId`, `no layers in group "${op.groupId}"`);
        }
        return;
      }
      default:
        fail(`${where}.op`, "must be addLayer, updateLayer, deleteLayer, moveLayer, nameGroup, addPage, updatePage, deletePage or movePage");
    }
  });

  // Pages whose content changed keep a stale preview otherwise; the editor
  // (or the renderer, later) makes a new one.
  const before = new Map(source.pages.map((page) => [page.id, JSON.stringify(page.layers)]));
  for (const page of design.pages) {
    if (before.get(page.id) !== JSON.stringify(page.layers)) {
      delete page.thumbnail;
    }
  }
  return { design, created };
}
