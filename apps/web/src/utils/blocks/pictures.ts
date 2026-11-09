import { type VisualPart } from "@mycanvas/shared";
import { aiImage } from "../ai-client";
import { DEFAULT_PICTURE_STYLE } from "./catalog";
import { pictureBox } from "./layout";

export { DEFAULT_PICTURE_STYLE };

/*
 * Pictures for visual blocks, made with the image model chosen in AI
 * settings (ComfyUI or another provider). Each picture is generated at
 * its frame's shape, so the frame's crop takes little away.
 */

/** At most this many pictures per design made in one go; the rest can be made from the page panel. */
export const MAX_PICTURES = 8;

/** What the picture should show: the planned description, else the page's own words. */
export function pictureSubject(part: VisualPart): string {
  const { slots } = part;
  return (slots.imageQuery ?? [slots.title, slots.text ?? slots.subtitle].filter(Boolean).join(". ")).trim();
}

/** Parts that have a place for a picture, no picture yet, and something to show. */
export function wantsPicture(part: VisualPart): boolean {
  if (part.slots.image) {
    return false;
  }
  if (part.block === "pictureText") {
    return pictureSubject(part) !== "";
  }
  return (part.block === "cover" || part.block === "quote") && Boolean(part.slots.imageQuery?.trim());
}

export function picturePrompt(subject: string, style?: string): string {
  const look = style?.trim() ?? "";
  return `${subject.replace(/[.\s]+$/, "")}. Style: ${look === "" ? DEFAULT_PICTURE_STYLE : look}. No text, no letters, no logos, no watermark.`;
}

/** Generation size with the frame's proportions, about 1024 on the long side. */
export function pictureSize(part: VisualPart, pageWidth: number, pageHeight: number): { width: number; height: number } {
  // Cover and quote frames only exist once there is a picture; measure as if there were one.
  const box = pictureBox({ ...part, slots: { ...part.slots, image: part.slots.image ?? "pending" } }, pageWidth, pageHeight);
  const width = box?.width ?? 1;
  const height = box?.height ?? 1;
  const scale = 1024 / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Makes one picture for the part; resolves to the new upload's file name. */
export function makePicture(part: VisualPart, pageWidth: number, pageHeight: number, style?: string, subject = pictureSubject(part)): Promise<string> {
  return aiImage(picturePrompt(subject, style), pictureSize(part, pageWidth, pageHeight), subject.slice(0, 60) || "Picture");
}

/**
 * Makes pictures for the parts that want one, one after another.
 * Returns the parts with their new pictures, and what couldn't be made.
 */
export async function makePictures(
  parts: VisualPart[],
  pageWidth: number,
  pageHeight: number,
  style: string | undefined,
  onProgress: (message: string) => void,
): Promise<{ parts: VisualPart[]; failed: string[]; skipped: number }> {
  const wanted = parts.filter(wantsPicture);
  const chosen = new Set(wanted.slice(0, MAX_PICTURES).map((part) => part.id));
  const failed: string[] = [];
  const out: VisualPart[] = [];
  let done = 0;
  for (const part of parts) {
    if (!chosen.has(part.id)) {
      out.push(part);
      continue;
    }
    done += 1;
    onProgress(`Making picture ${String(done)} of ${String(chosen.size)}…`);
    try {
      const asset = await makePicture(part, pageWidth, pageHeight, style);
      out.push({ ...part, slots: { ...part.slots, image: asset, imageQuery: pictureSubject(part) } });
    } catch (reason) {
      failed.push(reason instanceof Error ? reason.message : "it failed");
      out.push(part);
    }
  }
  return { parts: out, failed, skipped: wanted.length - chosen.size };
}
