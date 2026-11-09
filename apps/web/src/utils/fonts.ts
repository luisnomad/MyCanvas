import { FONT_WEIGHTS, GOOGLE_FONTS, parseFontStyle } from "@mycanvas/shared";

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
  if (!isGoogleFont(family)) {
    return null;
  }
  let probe = weightProbes.get(family);
  if (!probe) {
    probe = Promise.all(FONT_WEIGHTS.map(async ({ weight }) => {
      try {
        const res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${String(weight)}`);
        return res.ok ? weight : null;
      } catch {
        return null;
      }
    })).then((weights) => {
      const found = weights.filter((weight): weight is number => weight !== null);
      // Offline or blocked: don't pretend the family has no weights.
      return found.length > 0 ? found : FONT_WEIGHTS.map((entry) => entry.weight);
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
