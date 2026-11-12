import { type BlockDesign } from "./blocks";

export interface ShadowEffect {
  enabled: boolean;
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
  /** Shadow opacity, 0-1. */
  opacity: number;
}

export interface StrokeEffect {
  enabled: boolean;
  color: string;
  width: number;
}

interface LayerBase {
  id: string;
  name: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  /** Group membership; layers sharing a groupId form a contiguous run. */
  groupId?: string;
  /** The group's name, kept on each member (absent = "Group N"). */
  groupName?: string;
  /** Locked layers: selectable but frozen — no transform/drag/nudge/delete/
   *  z-order/property edits, and marquee selection skips them. */
  locked?: boolean;
  /** Only meaningful inside a document format (see FormatRole). */
  formatRole?: FormatRole;
  /** Designs made of visual blocks: the slot this layer shows (e.g. "title",
   *  "items.2.text"), so hand edits survive switching the page's block. */
  blockSlot?: string;
}

/** Content block kinds a document format can style. */
export type BlockKind = "title" | "lead" | "heading" | "body" | "callout" | "image";

export const BLOCK_KINDS: { id: BlockKind; label: string }[] = [
  { id: "title", label: "Title" },
  { id: "lead", label: "Lead" },
  { id: "heading", label: "Heading" },
  { id: "body", label: "Body text" },
  { id: "callout", label: "Callout" },
  { id: "image", label: "Image" },
];

/**
 * What a layer does in a document format. Layers without a role are
 * decoration and repeat on every page made from their master page.
 * - flow: a rectangle marking where content flows on that master.
 * - sample: shows how one block kind looks (text, or image for "image");
 *   its position inside the flow area sets the block's indent.
 * - box: a rectangle drawn around a sample; every block of that kind gets
 *   a box with the same padding.
 * - hideOnLast: decoration left off the document's final page (e.g. a
 *   "next page" arrow).
 * - reference: a guide for whoever edits the format; documents leave it out.
 */
export type FormatRole =
  | { kind: "flow" }
  | { kind: "sample"; block: BlockKind; /** Gap above the block, px. */ spaceBefore: number }
  | { kind: "box"; block: BlockKind }
  | { kind: "hideOnLast" }
  /** Shown while designing (e.g. the example a format was made from); never in documents. */
  | { kind: "reference" };

/** Mutually-exclusive text effects (Canva model: one effect or none). */
export type TextEffect =
  | { type: "none" }
  | { type: "shadow"; color: string; distance: number; angle: number; blur: number; opacity: number }
  | { type: "glow"; color: string; spread: number; strength: number; /** Optional for saved glows made before Blur was added. */ blur?: number }
  | { type: "outline"; color: string; thickness: number }
  | { type: "echo"; color: string; distance: number; angle: number }
  | { type: "background"; color: string; spread: number; roundness: number; opacity: number }
  | { type: "glitch"; colorPair: "cyan-magenta" | "red-blue"; distance: number; angle: number };

/** Curated defaults that look good on a 1280×720 thumbnail. */
export function defaultTextEffect(type: Exclude<TextEffect["type"], "none">): TextEffect {
  switch (type) {
    case "shadow":
      return { type: "shadow", color: "#000000", distance: 8, angle: 45, blur: 12, opacity: 0.6 };
    case "glow":
      return { type: "glow", color: "#ffe600", spread: 16, blur: 20, strength: 70 };
    case "outline":
      return { type: "outline", color: "#ffffff", thickness: 4 };
    case "echo":
      return { type: "echo", color: "#6b6b76", distance: 6, angle: 45 };
    case "background":
      return { type: "background", color: "#ffe600", spread: 12, roundness: 40, opacity: 1 };
    case "glitch":
      return { type: "glitch", colorPair: "cyan-magenta", distance: 6, angle: 0 };
  }
}

export interface TextLayer extends LayerBase {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  /** Konva-style font style string: any combination of "bold" and "italic" separated by spaces, or "normal". */
  fontStyle: string;
  fill: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  /** Fixed wrap width in px; 0 means auto (no wrapping). Ignored while curved. */
  wrapWidth: number;
  /** Bend amount, -100 (smile) … 100 (arch); 0/absent = straight. Curved text is single-line. */
  curve?: number;
  /** The single active text effect; absent on legacy layers (migrated on load). */
  effect?: TextEffect;
  /** Legacy storage for the shadow/outline effect params; kept in sync by migration. */
  shadow: ShadowEffect;
  stroke: StrokeEffect;
}

export type ImageFilterPreset = "none" | "mono" | "noir" | "sepia" | "vintage" | "warm" | "cool" | "vivid" | "fade";

/** Non-destructive image look, applied at render time. Absent/0 = unchanged. */
export interface ImageAdjustments {
  preset?: ImageFilterPreset;
  /** -100…100 */
  brightness?: number;
  /** -100…100 */
  contrast?: number;
  /** -100…100 */
  saturation?: number;
  /** Hue rotation in degrees, -180…180. */
  hue?: number;
  /** Blur radius in design px (scales with the layer), 0…50. */
  blur?: number;
}

/** Gradient fill; overrides the solid fill while present. */
export interface GradientFill {
  type: "linear" | "radial";
  /** Linear direction in degrees: 0 = left→right, 90 = top→bottom. */
  angle: number;
  /** Two or more stops, offsets 0…1, ascending. */
  stops: { offset: number; color: string }[];
}

export interface BehindText {
  mode: "outline";
  /** Outline thickness in design px (independent of the text's scale). */
  width: number;
}

export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageLayer extends LayerBase {
  type: "image";
  /** Asset file name served by the backend (e.g. "abc123.png"). */
  asset: string;
  width: number;
  height: number;
  /** Source-space crop rect (px in the original image). Absent = full image. */
  crop?: ImageCrop;
  /** True when the asset is an isolated-subject cutout (from remove-background
   *  or text-behind-subject) — subject extraction is meaningless on it. */
  cutout?: boolean;
  /** On a subject cutout: how text layers beneath it show where the subject
   *  covers them. Absent = hidden (classic text behind subject); "outline"
   *  draws the covered letters on top as outlines in the text's own color. */
  behindText?: BehindText;
  adjust?: ImageAdjustments;
  /** Mirror the picture inside the layer box (geometry is unchanged). */
  flipX?: boolean;
  flipY?: boolean;
  shadow: ShadowEffect;
}

export interface RectLayer extends LayerBase {
  type: "rect";
  width: number;
  height: number;
  fill: string;
  gradient?: GradientFill;
  cornerRadius: number;
  stroke: StrokeEffect;
  shadow: ShadowEffect;
}

export interface LineLayer extends LayerBase {
  type: "line";
  points: [number, number, number, number];
  /** Bend point: present = a smooth curve (quadratic Bézier) from the first
   *  point to the second, pulled towards this point (same units as points). */
  control?: [number, number];
  strokeColor: string;
  strokeWidth: number;
  lineCap: "butt" | "round" | "square";
  shadow: ShadowEffect;
}

export type ShapeKind = "triangle" | "hexagon" | "circle" | "semicircle" | "star";

export interface ShapeLayer extends LayerBase {
  type: "shape";
  shape: ShapeKind;
  width: number;
  height: number;
  fill: string;
  gradient?: GradientFill;
  /** Rounded corners (px). Optional/0 = sharp; meaningless on circles. */
  cornerRadius?: number;
  stroke: StrokeEffect;
  shadow: ShadowEffect;
}

export type FrameShape = "rect" | ShapeKind;

/** Image content inside a frame: asset + placement in frame-local units. */
export interface FrameContent {
  asset: string;
  offsetX: number;
  offsetY: number;
  /** Cover-fit scale (image px → frame px); >= cover scale at all times. */
  scale: number;
}

export interface FrameLayer extends LayerBase {
  type: "frame";
  shape: FrameShape;
  width: number;
  height: number;
  /** Rounded corners (px). Optional/0 = sharp; meaningless on circles. */
  cornerRadius?: number;
  /** Absent = empty frame (renders the placeholder illustration). */
  content?: FrameContent;
  adjust?: ImageAdjustments;
  flipX?: boolean;
  flipY?: boolean;
  /**
   * The photo's angle on the page, in degrees. Set: the photo keeps that
   * angle when the frame rotates (content offsets are then in the box from
   * frameContentBox). Absent: the photo turns with the frame.
   */
  contentRotation?: number;
}

export type Layer = TextLayer | ImageLayer | RectLayer | LineLayer | ShapeLayer | FrameLayer;
export type LayerType = Layer["type"];

/** What one page of a design shows. */
export interface PageContent {
  /** Page background color, or "transparent". */
  background: string;
  /** Overrides `background` when present (ignored while transparent). */
  backgroundGradient?: GradientFill;
  /** Layers in z-order: index 0 is the bottom-most layer. */
  layers: Layer[];
}

/** One page of a multi-page design; every page shares the design's size. */
export interface DesignPage extends PageContent {
  id: string;
  /** Small data-URL preview, refreshed when the page is saved while open. */
  thumbnail?: string;
}

export interface Design {
  id: string;
  name: string;
  width: number;
  height: number;
  /** One or more pages, in order. */
  pages: DesignPage[];
  /** Small data-URL preview of the first page, for the project list. */
  thumbnail?: string;
  /** Project folder (e.g. a customer); absent = unfiled. Changed only through
   *  the move endpoint, never by editor saves. */
  folderId?: string;
  /** "format": a document format whose pages are masters (see FormatRole). */
  kind?: "format";
  /** Set on documents made from a format, so the content can be re-flowed. */
  source?: DocumentSource;
  /** Formats only: instructions for the AI tools. */
  formatAi?: FormatAiInstructions;
  /** Designs made of visual blocks: the theme and each page's block. */
  blocks?: BlockDesign;
  /** Incremented by the server on every write; absent on older files (= 0). */
  revision?: number;
  createdAt: string;
  updatedAt: string;
}

/** How AI should treat content for a format, in the person's own words. */
export interface FormatAiInstructions {
  /** E.g. "Lines starting with IDEA CLAVE or SEÑAL CLAVE are callouts." */
  contentRules?: string;
  /** Visual style added to every illustration prompt. */
  illustrationStyle?: string;
}

/** The content and format a generated document was made from. */
export interface DocumentSource {
  formatId: string;
  formatName: string;
  /** The content, in the format's simple Markdown dialect. */
  markdown: string;
  generatedAt: string;
  /** The format's version used: its updatedAt when the layout was made.
   *  Absent on documents from before versioning (use generatedAt). */
  formatUpdatedAt?: string;
}

/** A design as stored on disk: older files keep one page's content inline. */
export type StoredDesign = Omit<Design, "pages"> & Partial<PageContent> & { pages?: DesignPage[] };

/**
 * Brings a stored design to the current shape. Single-page designs from
 * before multi-page support become one page; legacy inline fields are
 * dropped so they can never disagree with `pages`.
 */
export function normalizeDesign(stored: StoredDesign): Design {
  const { background, backgroundGradient, layers, pages, ...rest } = stored;
  if (pages && pages.length > 0) {
    return { ...rest, pages };
  }
  return {
    ...rest,
    pages: [{
      id: "page-1",
      background: background ?? "#ffffff",
      backgroundGradient,
      layers: layers ?? [],
      thumbnail: rest.thumbnail,
    }],
  };
}

/** Every layer on every page (for asset usage and similar scans). */
export function allLayers(design: Pick<Design, "pages">): Layer[] {
  return design.pages.flatMap((page) => page.layers);
}

/** A project folder in a person's workspace, e.g. one per customer. */
export interface Folder {
  id: string;
  name: string;
  createdAt: string;
}

export interface DesignSummary {
  id: string;
  name: string;
  folderId?: string;
  kind?: "format";
  /** Name of the format a generated document came from. */
  sourceFormat?: string;
  width: number;
  height: number;
  pageCount: number;
  thumbnail?: string;
  createdAt: string;
  updatedAt: string;
  /** The design's current revision (0 for files from before revisions). */
  revision?: number;
}

export function defaultShadow(): ShadowEffect {
  return { enabled: false, color: "#000000", blur: 12, offsetX: 0, offsetY: 4, opacity: 0.8 };
}

export function defaultStroke(): StrokeEffect {
  return { enabled: false, color: "#000000", width: 2 };
}

/** Who is editing a design (see docs/AGENT_API.md, "Lock model"). */
export interface DesignLock {
  designId: string;
  holder: "agent" | "human";
  /** "Claude" or the person's email. */
  label: string;
  /** Whose lock it is (for the agent: the workspace owner it works for). */
  email: string;
  since: string;
}

/** A font face uploaded into a workspace (see docs/AGENT_API.md, "Fonts"). */
export interface CustomFont {
  /** Its file name, served at /fonts/<id>. */
  id: string;
  /** From the font's own name table, or given at upload. */
  family: string;
  /** 100–900. */
  weight: number;
  italic: boolean;
  /** Has a weight axis: PDFs embed its default weight only. */
  variable: boolean;
  originalName: string;
  uploadedAt: string;
}
