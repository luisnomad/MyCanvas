/** Image exports, like the editor: up to 4x, and never above this many px per side. */
export const IMAGE_MAX_SCALE = 4;
export const IMAGE_MAX_SIDE = 16000;
export const IMAGE_SIZE_HELP = "Use scale=0.1–4 or width=<px> (the output is at most 16000 px per side)";

/**
 * The pixel ratio for an image export: `width` (output px wide) wins over
 * `scale`. Null when either is invalid or the output would pass
 * IMAGE_MAX_SIDE on a side.
 */
export function imageScale(query: { scale?: string | undefined; width?: string | undefined }, designWidth: number, designHeight: number): number | null {
  let scale: number;
  if (query.width !== undefined) {
    const width = Number(query.width);
    if (!Number.isInteger(width) || width < 16 || designWidth <= 0) {
      return null;
    }
    scale = width / designWidth;
  } else {
    scale = query.scale === undefined ? 1 : Number(query.scale);
    if (!Number.isFinite(scale) || scale < 0.1 || scale > IMAGE_MAX_SCALE) {
      return null;
    }
  }
  return Math.max(designWidth, designHeight) * scale <= IMAGE_MAX_SIDE + 0.5 ? scale : null;
}
