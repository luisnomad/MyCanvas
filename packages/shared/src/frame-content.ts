import { type FrameContent } from "./design";

/*
 * Where a frame's photo lives. Normally the photo turns with the frame and
 * its placement (offsetX/offsetY/scale) is in the frame's own box. With
 * `contentRotation` set, the photo keeps that angle on the page whatever the
 * frame's rotation: it is placed in a box turned by (contentRotation −
 * rotation) around the frame's center, big enough to cover the frame, and
 * offsetX/offsetY/scale are in that box.
 */

export interface ContentBox {
  width: number;
  height: number;
  /** The photo's angle relative to the frame, degrees (0 = turns with it). */
  angle: number;
}

interface FrameGeometry {
  width: number;
  height: number;
  rotation: number;
  contentRotation?: number;
}

/** The box a frame's photo is placed in (see above). */
export function frameContentBox(frame: FrameGeometry): ContentBox {
  if (frame.contentRotation === undefined) {
    return { width: frame.width, height: frame.height, angle: 0 };
  }
  const angle = frame.contentRotation - frame.rotation;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  // Round away float noise (cos 90° is 6e-17), so 90° turns give exact boxes.
  const tidy = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    width: tidy(frame.width * cos + frame.height * sin),
    height: tidy(frame.width * sin + frame.height * cos),
    angle,
  };
}

/** Cover-fit scale: the smallest scale at which the image covers the box. */
export function coverScale(imgW: number, imgH: number, boxW: number, boxH: number): number {
  return Math.max(boxW / imgW, boxH / imgH);
}

/** Initial placement: cover-fit, centered. */
export function coverContent(asset: string, imgW: number, imgH: number, boxW: number, boxH: number): FrameContent {
  const scale = coverScale(imgW, imgH, boxW, boxH);
  return { asset, scale, offsetX: (boxW - imgW * scale) / 2, offsetY: (boxH - imgH * scale) / 2 };
}

/** Clamp offsets so the image always covers the box (no empty edges). */
export function clampContent(content: FrameContent, imgW: number, imgH: number, boxW: number, boxH: number): FrameContent {
  const scale = Math.max(content.scale, coverScale(imgW, imgH, boxW, boxH));
  return {
    ...content,
    scale,
    offsetX: Math.min(0, Math.max(boxW - imgW * scale, content.offsetX)),
    offsetY: Math.min(0, Math.max(boxH - imgH * scale, content.offsetY)),
  };
}

/**
 * Re-cover after the box changed (resize, rotation with a fixed photo
 * angle): keeps the zoom ratio over cover and the visible center, then clamps.
 */
export function recoverContent(
  content: FrameContent,
  imgW: number,
  imgH: number,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): FrameContent {
  const zoomRatio = content.scale / coverScale(imgW, imgH, oldW, oldH);
  const scale = Math.max(coverScale(imgW, imgH, newW, newH) * zoomRatio, coverScale(imgW, imgH, newW, newH));
  // The image point at the box center stays centered.
  const centerX = (oldW / 2 - content.offsetX) / content.scale;
  const centerY = (oldH / 2 - content.offsetY) / content.scale;
  return clampContent(
    { asset: content.asset, scale, offsetX: newW / 2 - centerX * scale, offsetY: newH / 2 - centerY * scale },
    imgW,
    imgH,
    newW,
    newH,
  );
}
