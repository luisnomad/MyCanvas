import type Konva from "konva";
import { type ImageAdjustments, type ImageFilterPreset } from "@mycanvas/shared";

/** Named looks; each is a CSS filter chain applied under the sliders. */
export const FILTER_PRESETS: { id: ImageFilterPreset; label: string; css: string }[] = [
  { id: "none", label: "Original", css: "" },
  { id: "vivid", label: "Vivid", css: "saturate(1.5) contrast(1.12)" },
  { id: "warm", label: "Warm", css: "sepia(0.22) saturate(1.25) hue-rotate(-8deg)" },
  { id: "cool", label: "Cool", css: "saturate(0.9) hue-rotate(12deg) brightness(1.03)" },
  { id: "fade", label: "Fade", css: "contrast(0.82) brightness(1.08) saturate(0.75)" },
  { id: "vintage", label: "Vintage", css: "sepia(0.35) contrast(1.1) saturate(0.8) brightness(1.05)" },
  { id: "sepia", label: "Sepia", css: "sepia(0.85)" },
  { id: "mono", label: "Mono", css: "grayscale(1)" },
  { id: "noir", label: "Noir", css: "grayscale(1) contrast(1.4) brightness(0.95)" },
];

export function hasAdjustments(adjust: ImageAdjustments | undefined): boolean {
  if (!adjust) {
    return false;
  }
  const { preset, brightness, contrast, saturation, hue, blur } = adjust;
  return (preset !== undefined && preset !== "none") ||
    [brightness, contrast, saturation, hue, blur].some((value) => value !== undefined && value !== 0);
}

/**
 * CSS filter string for an adjustment set. `blurScale` converts design px to
 * the target's px (canvas filters blur in device pixels, ignoring the
 * transform). Returns "none" when nothing applies.
 */
export function cssFilterFor(adjust: ImageAdjustments | undefined, blurScale = 1): string {
  if (!adjust) {
    return "none";
  }
  const parts: string[] = [];
  const preset = FILTER_PRESETS.find((entry) => entry.id === adjust.preset)?.css;
  if (preset) {
    parts.push(preset);
  }
  if (adjust.brightness) {
    parts.push(`brightness(${String(1 + adjust.brightness / 100)})`);
  }
  if (adjust.contrast) {
    parts.push(`contrast(${String(1 + adjust.contrast / 100)})`);
  }
  if (adjust.saturation) {
    parts.push(`saturate(${String(1 + adjust.saturation / 100)})`);
  }
  if (adjust.hue) {
    parts.push(`hue-rotate(${String(adjust.hue)}deg)`);
  }
  if (adjust.blur) {
    parts.push(`blur(${String(adjust.blur * blurScale)}px)`);
  }
  return parts.length > 0 ? parts.join(" ") : "none";
}

interface ImageLook {
  adjust?: ImageAdjustments;
  flipX?: boolean;
  flipY?: boolean;
}

/** Longest side of an offscreen blur buffer, in device px. */
const MAX_BUFFER_SIDE = 8192;

interface BlurCacheEntry {
  key: string;
  canvas: HTMLCanvasElement;
}

/** Per-node blurred renders; a couple of keys (screen + thumbnail/export). */
const blurCache = new WeakMap<Konva.Shape, BlurCacheEntry[]>();

/**
 * Renders the node's picture through `filter` (blur included) into an opaque
 * w×h buffer. The source is first padded with mirrored copies of its own
 * edges, so the blur samples real pixels instead of fading to transparent at
 * the borders (which reads as a dark/light halo).
 */
function blurredBuffer(shape: Konva.Image, filter: string, blurPx: number, scale: number): HTMLCanvasElement | null {
  const image = shape.image() as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image) {
    return null;
  }
  const w = shape.width();
  const h = shape.height();
  const crop = shape.crop();
  const hasCrop = crop.width > 0 && crop.height > 0;
  const sx = hasCrop ? crop.x : 0;
  const sy = hasCrop ? crop.y : 0;
  const sw = hasCrop ? crop.width : image.width;
  const sh = hasCrop ? crop.height : image.height;
  const ratio = Math.min(scale, MAX_BUFFER_SIDE / Math.max(w, h));
  const key = [filter, ratio, w, h, sx, sy, sw, sh, (image as { src?: string }).src ?? ""].join("|");
  const entries = blurCache.get(shape) ?? [];
  const hit = entries.find((entry) => entry.key === key);
  if (hit) {
    return hit.canvas;
  }

  // Three blur radii of padding (design px), never more than the box itself.
  const pad = Math.min(Math.ceil((blurPx / Math.max(scale, 1e-6)) * 3), w, h);
  const padded = document.createElement("canvas");
  padded.width = Math.ceil((w + pad * 2) * ratio);
  padded.height = Math.ceil((h + pad * 2) * ratio);
  const pctx = padded.getContext("2d");
  const out = document.createElement("canvas");
  out.width = Math.ceil(w * ratio);
  out.height = Math.ceil(h * ratio);
  const octx = out.getContext("2d");
  if (!pctx || !octx) {
    return null;
  }
  pctx.scale(ratio, ratio);
  pctx.translate(pad, pad);
  for (const i of [-1, 0, 1]) {
    for (const j of [-1, 0, 1]) {
      pctx.save();
      // Reflect across the left/right (top/bottom) edge for the side tiles.
      pctx.translate(i === 1 ? w * 2 : 0, j === 1 ? h * 2 : 0);
      pctx.scale(i === 0 ? 1 : -1, j === 0 ? 1 : -1);
      pctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);
      pctx.restore();
    }
  }
  octx.filter = filter.replace(/blur\([^)]*\)/, `blur(${String(blurPx * (ratio / scale))}px)`);
  octx.drawImage(padded, -pad * ratio, -pad * ratio);

  blurCache.set(shape, [{ key, canvas: out }, ...entries].slice(0, 3));
  return out;
}

/**
 * Konva.Image sceneFunc that draws the picture through a CSS filter and/or
 * mirrored. Resolution-independent (no node caching), so exports at any
 * pixel ratio stay sharp. Undefined when the look is plain, which keeps
 * Konva's default fast path. Mirroring pivots on `pivot` (shape-local; the
 * image box center by default) — frames pass their own center so the
 * visible region stays put.
 */
export function imageLookSceneFunc(
  look: ImageLook,
  pivot?: { x: number; y: number },
): ((context: Konva.Context, shape: Konva.Shape) => void) | undefined {
  const filtered = hasAdjustments(look.adjust);
  if (!filtered && !look.flipX && !look.flipY) {
    return undefined;
  }
  return (context, shape) => {
    const ctx = context._context;
    ctx.save();
    if (look.flipX || look.flipY) {
      const px = pivot?.x ?? shape.width() / 2;
      const py = pivot?.y ?? shape.height() / 2;
      ctx.translate(look.flipX ? px * 2 : 0, look.flipY ? py * 2 : 0);
      ctx.scale(look.flipX ? -1 : 1, look.flipY ? -1 : 1);
    }
    // Canvas filters work in device px, ignoring the transform.
    const m = ctx.getTransform();
    const scale = Math.hypot(m.a, m.b);
    const blur = look.adjust?.blur ?? 0;
    const buffer = blur > 0
      ? blurredBuffer(shape as Konva.Image, cssFilterFor(look.adjust, scale), blur * scale, scale)
      : null;
    if (buffer) {
      ctx.drawImage(buffer, 0, 0, shape.width(), shape.height());
    } else {
      if (filtered) {
        ctx.filter = cssFilterFor(look.adjust, scale);
      }
      (shape as unknown as { _sceneFunc: (context: Konva.Context) => void })._sceneFunc(context);
    }
    ctx.restore();
  };
}
