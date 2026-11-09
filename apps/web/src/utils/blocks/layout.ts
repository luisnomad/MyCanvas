import { type VisualPart } from "@mycanvas/shared";

/* Page geometry shared by the renderer and picture generation (no canvas code here). */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a part's picture goes on a W × H page, or null when it shows none.
 * A cover or quote shows one only once it has a picture.
 */
export function pictureBox(part: VisualPart, W: number, H: number): Box | null {
  const block = part.block;
  if (block !== "pictureText" && !((block === "cover" || block === "quote") && part.slots.image !== undefined)) {
    return null;
  }
  const side = part.variant.side ?? "top";
  if (side === "top") {
    return { x: 0, y: 0, width: W, height: Math.round(H * (block === "cover" ? 0.5 : 0.46)) };
  }
  const width = Math.round(W * 0.46);
  return { x: side === "left" ? 0 : W - width, y: 0, width, height: H };
}
