import { GOOGLE_FONTS } from "@mycanvas/shared";

/*
 * PDF font names → a usable font. Embedded names look like
 * "ABCDEF+Montserrat-Black", "OpenSans-SemiBoldItalic" or "Arial,Bold".
 */

export interface ParsedFont {
  /** Family as written in the PDF, spaced ("Open Sans"). */
  family: string;
  weight: number;
  italic: boolean;
}

export interface ResolvedFont extends ParsedFont {
  /** The family to use: the same Google font, or a stand-in. */
  use: string;
  /** False when `use` is a stand-in for a font we don't have. */
  exact: boolean;
}

const WEIGHT_WORDS: [RegExp, number][] = [
  [/(?:extra|ultra)light/i, 200],
  [/(?:semi|demi)bold/i, 600],
  [/(?:extra|ultra)bold/i, 800],
  [/thin|hairline/i, 100],
  [/light/i, 300],
  [/medium/i, 500],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

export function parsePdfFontName(raw: string): ParsedFont {
  // Subset prefix ("ABCDEF+") and PostScript/Windows separators.
  const name = raw.replace(/^[A-Z]{6}\+/, "");
  const [familyPart = name, ...styleParts] = name.split(/[-,]/);
  const style = styleParts.join(" ");
  // A style glued to the family ("ArialBold", "MontserratBlack") counts too.
  const glued = /^(.*?)(Thin|ExtraLight|UltraLight|Light|Regular|Book|Medium|SemiBold|DemiBold|Bold|ExtraBold|UltraBold|Black|Heavy|Italic|Oblique)+(?:MT|PS)?$/.exec(familyPart);
  const familyRaw = style === "" && glued?.[1] ? glued[1] : familyPart;
  const styleText = style === "" && glued?.[1] ? familyPart.slice(glued[1].length) : style;
  let weight = 400;
  for (const [pattern, value] of WEIGHT_WORDS) {
    if (pattern.test(styleText)) {
      weight = value;
      break;
    }
  }
  const family = familyRaw
    .replace(/(?:MT|PS|Std|Pro|LT)$/, "")
    // "OpenSans" → "Open Sans", "RobotoCondensed" → "Roboto Condensed".
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
  return { family, weight, italic: /italic|oblique/i.test(styleText) };
}

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const googleBySquashed = new Map(GOOGLE_FONTS.map((font) => [squash(font.family), font.family]));

/** Common fonts without a Google copy, and the closest Google family we have. */
const STAND_INS: [RegExp, string][] = [
  [/helvetica|arial|liberation sans|nimbus sans/i, "Inter"],
  [/times|georgia|cambria|garamond|minion/i, "Libre Baskerville"],
  [/bodoni|didot|didone/i, "Bodoni Moda"],
  [/futura|avenir|gotham|proxima/i, "Montserrat"],
  [/myriad|segoe|calibri|frutiger|source sans/i, "Open Sans"],
  [/din|condensed|narrow/i, "Roboto Condensed"],
  [/courier|mono|consol/i, "Roboto Mono"],
];

export function resolvePdfFont(raw: string): ResolvedFont {
  const parsed = parsePdfFontName(raw);
  const exact = googleBySquashed.get(squash(parsed.family));
  if (exact) {
    return { ...parsed, use: exact, exact: true };
  }
  const standIn = STAND_INS.find(([pattern]) => pattern.test(parsed.family))?.[1];
  const serifish = /serif|roman|book|old|caslon|baskerville/i.test(parsed.family) && !/sans/i.test(parsed.family);
  return { ...parsed, use: standIn ?? (serifish ? "Libre Baskerville" : "Inter"), exact: false };
}
