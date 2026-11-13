/** Image export sizes: a scale of the design, or an output width in px. */

export const SCALE_OPTIONS = ["0.25", "0.5", "0.75", "1", "2", "3", "4"];

/** Output widths offered directly (px). */
export const WIDTH_OPTIONS: { width: number; label: string }[] = [
  { width: 1920, label: "1920 px wide (Full HD)" },
  { width: 2160, label: "2160 px wide (4K, square/portrait)" },
  { width: 3840, label: "3840 px wide (4K)" },
];

/** Browsers refuse canvases much larger than this per side. */
export const MAX_EXPORT_SIDE = 16000;

/**
 * The pixel ratio for a size choice ("s:2" = 2x scale, "w:3840" = 3840 px
 * wide, "custom" = `customWidth` px wide), capped so neither output side
 * passes MAX_EXPORT_SIDE.
 */
export function exportPixelRatio(
  choice: string,
  customWidth: number,
  designWidth: number,
  designHeight: number,
): { ratio: number; capped: boolean } {
  let ratio: number;
  if (choice.startsWith("s:")) {
    ratio = Number(choice.slice(2));
  } else {
    const width = choice === "custom" ? customWidth : Number(choice.slice(2));
    ratio = designWidth > 0 ? width / designWidth : 1;
  }
  if (!Number.isFinite(ratio) || ratio <= 0) {
    ratio = 1;
  }
  const maxRatio = MAX_EXPORT_SIDE / Math.max(designWidth, designHeight, 1);
  return ratio > maxRatio ? { ratio: maxRatio, capped: true } : { ratio, capped: false };
}
