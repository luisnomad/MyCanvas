import { FONT_WEIGHTS, GOOGLE_FONTS, parseFontStyle } from "@mycanvas/shared";
import { customFonts, isCustomFont, setFamiliesChangedHandler } from "./custom-fonts";

const googleFamilies = new Set(GOOGLE_FONTS.map((font) => font.family));

const done = new Set<string>();
const pending = new Map<string, Promise<void>>();

export function isGoogleFont(family: string): boolean {
  return googleFamilies.has(family);
}

/** Injects a Google Fonts stylesheet and resolves when it loaded or failed. */
function addStylesheet(href: string): Promise<void> {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  // document.fonts.load() only knows about faces declared by the stylesheet,
  // so wait for the CSS to arrive before asking for the faces.
  const ready = new Promise<void>((resolve) => {
    link.onload = () => {
      resolve();
    };
    // A weight the family doesn't have answers 400; the browser then uses
    // the nearest face it has.
    link.onerror = () => {
      resolve();
    };
  });
  document.head.appendChild(link);
  return ready;
}

// When custom fonts arrive or change, earlier attempts for those families
// (which may have drawn a fallback) must run again.
setFamiliesChangedHandler((families) => {
  const changed = new Set(families);
  for (const key of [...done]) {
    if (changed.has(key.split("|")[0] ?? "")) {
      done.delete(key);
    }
  }
});

function once(key: string, load: () => Promise<void>): Promise<void> {
  if (done.has(key)) {
    return Promise.resolve();
  }
  const existing = pending.get(key);
  if (existing) {
    return existing;
  }
  const promise = load()
    .catch(() => undefined)
    .then(() => {
      // Failed loads (offline, unknown family) count as done so callers
      // are never stuck waiting.
      done.add(key);
      pending.delete(key);
    });
  pending.set(key, promise);
  return promise;
}

/**
 * Ensures a font is usable for Konva text rendering: the family's regular
 * and bold faces, plus the face for `fontStyle` (a layer's style string, which
 * may carry a weight such as "300" or "italic 900"). Google fonts get their
 * stylesheets injected once per session; other names are assumed to be
 * installed locally and are just awaited through the Font Loading API.
 */
export function ensureFontLoaded(family: string, fontStyle = "normal"): Promise<void> {
  const trimmed = family.trim();
  if (!trimmed) {
    return Promise.resolve();
  }
  const google = isGoogleFont(trimmed);
  const base = once(trimmed, async () => {
    if (google) {
      await addStylesheet(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(trimmed)}:wght@400;700&display=swap`);
    }
    await Promise.all([
      document.fonts.load(`16px "${trimmed}"`),
      document.fonts.load(`bold 16px "${trimmed}"`),
    ]);
  });
  const { weight, italic } = parseFontStyle(fontStyle);
  if (!italic && (weight === 400 || weight === 700)) {
    return base;
  }
  const variant = once(`${trimmed}|${String(weight)}|${italic ? "i" : "n"}`, async () => {
    if (google) {
      await addStylesheet(
        `https://fonts.googleapis.com/css2?family=${encodeURIComponent(trimmed)}:ital,wght@${italic ? "1" : "0"},${String(weight)}&display=swap`,
      );
    }
    await document.fonts.load(`${italic ? "italic " : ""}${String(weight)} 16px "${trimmed}"`);
  });
  return Promise.all([base, variant]).then(() => undefined);
}

/** Loads every family/style pair, in parallel. */
export function ensureFontsLoaded(fonts: Iterable<string | { fontFamily: string; fontStyle: string }>): Promise<void> {
  return Promise.all(Array.from(fonts, (font) =>
    typeof font === "string" ? ensureFontLoaded(font) : ensureFontLoaded(font.fontFamily, font.fontStyle))).then(() => undefined);
}

const weightProbes = new Map<string, Promise<number[]>>();

/**
 * Upright weights a Google font family really has (Google answers 400 for
 * missing ones). Other fonts: null, since installed fonts can't be listed
 * per weight everywhere; the browser picks the nearest face.
 */
export function availableWeights(family: string): Promise<number[]> | null {
  if (isCustomFont(family)) {
    const faces = customFonts().filter((font) => font.family === family);
    // A variable font has every weight.
    return Promise.resolve(faces.some((font) => font.variable)
      ? FONT_WEIGHTS.map((entry) => entry.weight)
      : [...new Set(faces.map((font) => font.weight))].sort((a, b) => a - b));
  }
  if (!isGoogleFont(family)) {
    return null;
  }
  let probe = weightProbes.get(family);
  if (!probe) {
    probe = fetch(`/api/fonts/weights?family=${encodeURIComponent(family)}`)
      .then(async (res) => (res.ok ? ((await res.json()) as { weights: number[] }).weights : []))
      .catch(() => [] as number[])
      .then((found) => {
        if (found.length === 0) {
          // Offline or blocked: offer every weight and ask again next time.
          weightProbes.delete(family);
          return FONT_WEIGHTS.map((entry) => entry.weight);
        }
        return found;
      });
    weightProbes.set(family, probe);
  }
  return probe;
}

interface LocalFontData {
  family: string;
}

/**
 * Font families installed on the machine running the browser. Uses the Local
 * Font Access API (Chrome/Edge, secure context, asks permission once) so the
 * list is right even when the server runs elsewhere; falls back to the
 * server's own font scan, which only matches when both run on one machine.
 */
export async function listLocalFonts(fallback: () => Promise<string[]>): Promise<string[]> {
  const query = (window as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (query) {
    try {
      const families = new Set((await query()).map((font) => font.family));
      if (families.size > 0) {
        return [...families].sort((a, b) => a.localeCompare(b));
      }
    } catch {
      // Permission denied or API unavailable here; use the server scan.
    }
  }
  return fallback();
}
