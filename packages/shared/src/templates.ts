import { type DesignSummary } from "./design";

/** A design snapshot that new designs can start from. */
export interface TemplateSummary extends DesignSummary {
  /** Shipped with the app (read-only); user templates live in data/templates. */
  builtIn: boolean;
}

export interface SizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** Named platform sizes offered next to the generic aspect ratios. */
export const PLATFORM_SIZES: SizePreset[] = [
  { id: "youtube-thumb", label: "YouTube thumbnail", width: 1280, height: 720 },
  { id: "instagram-post", label: "Instagram post", width: 1080, height: 1080 },
  { id: "instagram-portrait", label: "Instagram portrait", width: 1080, height: 1350 },
  { id: "instagram-story", label: "Story / Reel", width: 1080, height: 1920 },
  { id: "x-post", label: "X post", width: 1600, height: 900 },
  { id: "x-header", label: "X header", width: 1500, height: 500 },
  { id: "linkedin-banner", label: "LinkedIn banner", width: 1584, height: 396 },
  { id: "a4-print", label: "A4 print (300 dpi)", width: 2480, height: 3508 },
];
