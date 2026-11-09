/**
 * A text layer's `fontStyle` is a CSS/Konva font-style string, which also
 * carries the weight: "normal", "bold", "italic", "italic bold", or a numeric
 * weight such as "300" or "italic 900". These helpers read and write it.
 */

export interface FontVariant {
  /** 100…900. */
  weight: number;
  italic: boolean;
}

export const FONT_WEIGHTS: { weight: number; label: string }[] = [
  { weight: 100, label: "Thin" },
  { weight: 200, label: "Extra Light" },
  { weight: 300, label: "Light" },
  { weight: 400, label: "Regular" },
  { weight: 500, label: "Medium" },
  { weight: 600, label: "Semibold" },
  { weight: 700, label: "Bold" },
  { weight: 800, label: "Extra Bold" },
  { weight: 900, label: "Black" },
];

export function parseFontStyle(fontStyle: string): FontVariant {
  let weight = 400;
  let italic = false;
  for (const token of fontStyle.toLowerCase().split(/\s+/)) {
    if (token === "italic" || token === "oblique") {
      italic = true;
    } else if (token === "bold") {
      weight = 700;
    } else if (/^[1-9]00$/.test(token)) {
      weight = Number(token);
    }
  }
  return { weight, italic };
}

/** Canonical string: keeps the classic "bold"/"normal" spellings for 700/400. */
export function formatFontStyle({ weight, italic }: FontVariant): string {
  const rounded = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  const weightPart = rounded === 400 ? "" : rounded === 700 ? "bold" : String(rounded);
  const parts = [italic ? "italic" : "", weightPart].filter((part) => part !== "");
  return parts.length > 0 ? parts.join(" ") : "normal";
}

/** True for weights a "B" toggle should show as on. */
export function isBoldWeight(weight: number): boolean {
  return weight >= 600;
}
