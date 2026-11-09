import { type BlockTheme, type Design, type Layer, type TextLayer } from "@mycanvas/shared";

/** #rrggbb → [r, g, b]; anything else → black. */
export function rgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match?.[1] ? Number.parseInt(match[1], 16) : 0;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("")}`;
}

/** `amount` of the way from a to b. */
export function mix(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return hex([ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount]);
}

function luminance(color: string): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Black or white, whichever reads better on `background`. */
export function readableOn(background: string): string {
  return contrast(background, "#ffffff") >= contrast(background, "#111111") ? "#ffffff" : "#111111";
}

export const THEMES: BlockTheme[] = [
  {
    id: "clear",
    name: "Clear",
    fonts: { heading: { family: "Inter", style: "800" }, body: { family: "Inter", style: "normal" } },
    colors: { background: "#ffffff", surface: "#f1f4f9", primary: "#2f5bea", onPrimary: "#ffffff", text: "#151922", muted: "#5b6372" },
    radius: 20,
  },
  {
    id: "editorial",
    name: "Editorial",
    fonts: { heading: { family: "Playfair Display", style: "bold" }, body: { family: "Lora", style: "normal" } },
    colors: { background: "#fbf7f0", surface: "#f1e8da", primary: "#b0432b", onPrimary: "#ffffff", text: "#231d17", muted: "#6d6157" },
    radius: 4,
  },
  {
    id: "night",
    name: "Night",
    fonts: { heading: { family: "Montserrat", style: "900" }, body: { family: "Open Sans", style: "normal" } },
    colors: { background: "#10132a", surface: "#1d2242", primary: "#ffc93c", onPrimary: "#15130c", text: "#f4f5fb", muted: "#a5abc6" },
    radius: 18,
  },
  {
    id: "fresh",
    name: "Fresh",
    fonts: { heading: { family: "Poppins", style: "bold" }, body: { family: "Poppins", style: "normal" } },
    colors: { background: "#f4fbf6", surface: "#dcf2e4", primary: "#108a5c", onPrimary: "#ffffff", text: "#122019", muted: "#4f6a5c" },
    radius: 28,
  },
  {
    id: "poster",
    name: "Poster",
    fonts: { heading: { family: "Barlow Condensed", style: "bold" }, body: { family: "Barlow", style: "normal" } },
    colors: { background: "#f6f4ef", surface: "#e7e3da", primary: "#e2462f", onPrimary: "#ffffff", text: "#141414", muted: "#5f5c57" },
    radius: 0,
  },
];

/**
 * A theme from a document format: its title and body samples' fonts, its
 * page colour, and an accent from its callout box or title colour.
 */
export function themeFromFormat(format: Design): BlockTheme | null {
  const page = format.pages[0];
  if (!page) {
    return null;
  }
  const layers: Layer[] = format.pages.flatMap((entry) => entry.layers);
  const sample = (block: string) => layers.find((layer): layer is TextLayer => layer.type === "text" && layer.formatRole?.kind === "sample" && layer.formatRole.block === block);
  const box = (block: string) => layers.find((layer) => layer.type === "rect" && layer.formatRole?.kind === "box" && layer.formatRole.block === block);
  const body = sample("body") ?? sample("lead");
  const heading = sample("title") ?? sample("heading") ?? body;
  if (!body || !heading) {
    return null;
  }
  const background = /^#[0-9a-f]{6}$/i.test(page.background) ? page.background : "#ffffff";
  const text = body.fill;
  const calloutBox = box("callout");
  const boxFill = calloutBox?.type === "rect" ? calloutBox.fill : undefined;
  // The accent: a coloured box, else the title's colour when it isn't just the text colour.
  const candidates = [boxFill, heading.fill, sample("heading")?.fill].filter((color): color is string => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color));
  const primary = candidates.find((color) => contrast(color, background) >= 2 && contrast(color, text) >= 1.4) ?? candidates[0] ?? "#2f5bea";
  return {
    id: `format:${format.id}`,
    name: format.name,
    fonts: {
      heading: { family: heading.fontFamily, style: heading.fontStyle },
      body: { family: body.fontFamily, style: body.fontStyle },
    },
    colors: {
      background,
      surface: mix(background, text, 0.07),
      primary,
      onPrimary: readableOn(primary),
      text,
      muted: mix(text, background, 0.35),
    },
    radius: 12,
  };
}
