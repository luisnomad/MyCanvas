import { useSyncExternalStore } from "react";
import { type CustomFont } from "@mycanvas/shared";
import { customFontsEndpoints } from "./endpoints";

/*
 * Fonts uploaded into this workspace (docs/AGENT_API.md, "Fonts"). Their
 * @font-face rules come from /api/fonts/custom.css; once loaded they work
 * like installed fonts on the canvas, in the picker and in PDF export.
 */

const LINK_ID = "mycanvas-custom-fonts";

let fonts: CustomFont[] = [];
let signature: string | null = null;
let version = 0;
let loading: Promise<void> | null = null;
/** A change arrived while a load was running: load once more after it. */
let again = false;
const LOAD_TIMEOUT_MS = 10_000;
const listeners = new Set<() => void>();
/** Families whose faces changed; fonts.ts forgets their earlier load attempts. */
let onFamiliesChanged: (families: string[]) => void = () => undefined;

export function setFamiliesChangedHandler(handler: (families: string[]) => void): void {
  onFamiliesChanged = handler;
}

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => { setTimeout(() => { resolve(fallback); }, LOAD_TIMEOUT_MS); })]);
}

function addStylesheet(href: string): Promise<void> {
  return withTimeout(new Promise<void>((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => { resolve(); };
    link.onerror = () => { resolve(); };
    const previous = document.getElementById(LINK_ID);
    link.id = LINK_ID;
    document.head.appendChild(link);
    // Swap only once the new rules are in, so text never flashes a fallback.
    link.addEventListener("load", () => { previous?.remove(); }, { once: true });
  }), undefined);
}

/**
 * Fetches the list of custom fonts and (re)loads their stylesheet when it
 * changed. Resolves once the faces are ready to draw with.
 */
export function loadCustomFonts(): Promise<void> {
  if (loading) {
    again = true;
    return loading;
  }
  loading = (async () => {
    try {
      const res = await fetch(customFontsEndpoints().list);
      if (!res.ok) {
        return;
      }
      const next = (await res.json()) as CustomFont[];
      const nextSignature = next.map((font) => font.id).join(",");
      if (nextSignature === signature) {
        return;
      }
      const changed = new Set([...fonts, ...next].map((font) => font.family));
      signature = nextSignature;
      fonts = next;
      await addStylesheet(`${customFontsEndpoints().css}?v=${encodeURIComponent(nextSignature.slice(0, 200))}`);
      await withTimeout(Promise.all(next.map((font) =>
        document.fonts.load(`${font.italic ? "italic " : ""}${String(font.weight)} 16px "${font.family}"`).catch(() => []))), []);
      onFamiliesChanged([...changed]);
      emit();
    } catch {
      // Offline or signed out: keep what we have.
    } finally {
      loading = null;
    }
    if (again) {
      again = false;
      await loadCustomFonts();
    }
  })();
  return loading;
}

export function customFonts(): CustomFont[] {
  return fonts;
}

export function isCustomFont(family: string): boolean {
  return fonts.some((font) => font.family === family);
}

/** The face to embed for a family/weight/style: same style, nearest weight. */
export function customFace(family: string, weight: number, italic: boolean): CustomFont | null {
  const faces = fonts.filter((font) => font.family === family);
  const sameStyle = faces.filter((font) => font.italic === italic);
  const pool = sameStyle.length > 0 ? sameStyle : faces;
  return pool.reduce<CustomFont | null>((best, font) =>
    !best || Math.abs(font.weight - weight) < Math.abs(best.weight - weight) ? font : best, null);
}

/** Re-renders when custom fonts load or change. */
export function useCustomFontsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => version,
  );
}

/** Uploads a .ttf/.otf; resolves to the stored face. */
export async function uploadCustomFont(file: File): Promise<CustomFont & { replaced: boolean }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/fonts/custom", { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as CustomFont & { replaced: boolean; error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? "The font couldn't be added");
  }
  await loadCustomFonts();
  return body;
}

export async function deleteCustomFont(id: string): Promise<void> {
  const res = await fetch(`/api/fonts/custom/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error("The font couldn't be removed");
  }
  await loadCustomFonts();
}
