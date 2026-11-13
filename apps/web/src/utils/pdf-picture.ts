import { type FrameLayer, type FrameShape, type ImageLayer, frameContentBox } from "@mycanvas/shared";
import { type Matrix, type PathCommand, ellipsePath, layerMatrix, multiplyMatrix, svgPathCommands } from "./pdf-vector";
import { roundedPolygonPath, shapePoints } from "./rounded-path";

/**
 * Picture placement for PDF export (pure: no DOM, no pdf-lib).
 *
 * An image layer draws a crop of its picture into its box; a frame draws
 * the whole picture at an offset and scale, clipped to the frame shape.
 * Both mirror inside the box (flipX/flipY) about the box center, like
 * LayerNode's imageLookSceneFunc. The placement says where the source
 * pixels land in layer-local space; the exporter either embeds the whole
 * original file (see fullPictureRect) or a render of just the source rect.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PicturePlacement {
  /** Layer-local → design px. */
  matrix: Matrix;
  /** Clip, layer-local. */
  clip: PathCommand[];
  /**
   * The picture's own space → layer-local, when it differs (a frame whose
   * photo keeps its angle: the counter-turned content box). Applied after
   * the clip and before the flip.
   */
  content?: Matrix;
  /** The box the flips mirror about (the content box when `content` is set). */
  width: number;
  height: number;
  flipX: boolean;
  flipY: boolean;
  /** Where `source` lands, layer-local (before the flip). */
  target: Rect;
  /** Picture pixels drawn into `target`. */
  source: Rect;
  opacity: number;
}

/** The frame shape as a path, as traceFramePath draws it (rounded corners are quadratics there, not arcs). */
export function framePath(shape: FrameShape, width: number, height: number, cornerRadius: number): PathCommand[] {
  if (shape === "circle") {
    return ellipsePath(width / 2, height / 2, width / 2, height / 2);
  }
  const points = shape === "rect" ? [0, 0, width, 0, width, height, 0, height] : shapePoints(shape, width, height);
  return svgPathCommands(roundedPolygonPath(points, cornerRadius)) ?? [];
}

function rectPathOf(width: number, height: number): PathCommand[] {
  return [
    { op: "M", x: 0, y: 0 },
    { op: "L", x: width, y: 0 },
    { op: "L", x: width, y: height },
    { op: "L", x: 0, y: height },
    { op: "Z" },
  ];
}

/** An image layer: its crop (or the whole picture) fills the layer box. */
export function imagePlacement(layer: ImageLayer, pictureWidth: number, pictureHeight: number): PicturePlacement {
  const crop = layer.crop && layer.crop.width > 0 && layer.crop.height > 0 ? layer.crop : { x: 0, y: 0, width: pictureWidth, height: pictureHeight };
  return {
    matrix: layerMatrix(layer),
    clip: rectPathOf(layer.width, layer.height),
    width: layer.width,
    height: layer.height,
    flipX: layer.flipX ?? false,
    flipY: layer.flipY ?? false,
    target: { x: 0, y: 0, width: layer.width, height: layer.height },
    source: { ...crop },
    opacity: Math.min(1, Math.max(0, layer.opacity)),
  };
}

/**
 * A filled frame: the whole picture at the content offset and scale, clipped
 * to the frame shape. With `contentRotation` the picture lives in the
 * counter-turned content box (frameContentBox), centered on the frame, like
 * the editor's frame-content holder.
 */
export function framePlacement(layer: FrameLayer, pictureWidth: number, pictureHeight: number): PicturePlacement | null {
  const content = layer.content;
  if (!content) {
    return null;
  }
  const box = frameContentBox(layer);
  let contentMatrix: Matrix | undefined;
  if (box.angle !== 0 || box.width !== layer.width || box.height !== layer.height) {
    const radians = (box.angle * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    contentMatrix = multiplyMatrix([cos, sin, -sin, cos, layer.width / 2, layer.height / 2], [1, 0, 0, 1, -box.width / 2, -box.height / 2]);
  }
  return {
    matrix: layerMatrix(layer),
    clip: framePath(layer.shape, layer.width, layer.height, layer.cornerRadius ?? 0),
    ...(contentMatrix ? { content: contentMatrix } : {}),
    width: box.width,
    height: box.height,
    flipX: layer.flipX ?? false,
    flipY: layer.flipY ?? false,
    target: { x: content.offsetX, y: content.offsetY, width: pictureWidth * content.scale, height: pictureHeight * content.scale },
    source: { x: 0, y: 0, width: pictureWidth, height: pictureHeight },
    opacity: Math.min(1, Math.max(0, layer.opacity)),
  };
}

/** Where the whole picture (pictureWidth × pictureHeight px) goes so that `source` lands on `target`. */
export function fullPictureRect(placement: PicturePlacement, pictureWidth: number, pictureHeight: number): Rect {
  const sx = placement.target.width / placement.source.width;
  const sy = placement.target.height / placement.source.height;
  return {
    x: placement.target.x - placement.source.x * sx,
    y: placement.target.y - placement.source.y * sy,
    width: pictureWidth * sx,
    height: pictureHeight * sy,
  };
}

/** The flip as a layer-local matrix (identity when there is none). */
export function flipMatrix(placement: PicturePlacement): Matrix | null {
  if (!placement.flipX && !placement.flipY) {
    return null;
  }
  return [placement.flipX ? -1 : 1, 0, 0, placement.flipY ? -1 : 1, placement.flipX ? placement.width : 0, placement.flipY ? placement.height : 0];
}

/**
 * The `cm` that maps PDF's unit image square onto `rect` in a y-down space:
 * the image's top edge sits at rect.y.
 */
export function pictureMatrix(rect: Rect): Matrix {
  return [rect.width, 0, 0, -rect.height, rect.x, rect.y + rect.height];
}

export type PictureKind = "jpeg" | "png";

/** The file type by magic bytes; null for anything pdf-lib can't embed as is (WebP, GIF, SVG…). */
export function sniffPicture(bytes: Uint8Array): PictureKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "png";
  }
  return null;
}

/**
 * The EXIF orientation tag of a JPEG (1 when absent or unreadable). Browsers
 * honor it when decoding, PDF viewers don't — a photo with any value but 1
 * must be re-encoded from the decoded pixels.
 */
export function jpegExifOrientation(bytes: Uint8Array): number {
  if (sniffPicture(bytes) !== "jpeg") {
    return 1;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return 1;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      return 1; // image data / end: no APP1 before it
    }
    const length = view.getUint16(at + 2);
    if (marker === 0xe1 && length >= 14 && at + 2 + length <= bytes.length) {
      const start = at + 4;
      const isExif = bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66 && bytes[start + 4] === 0 && bytes[start + 5] === 0;
      if (isExif) {
        const tiff = start + 6;
        const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
        const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
        if (!little && !big) {
          return 1;
        }
        const u16 = (offset: number) => view.getUint16(offset, little);
        const u32 = (offset: number) => view.getUint32(offset, little);
        if (u16(tiff + 2) !== 0x2a) {
          return 1;
        }
        const ifd = tiff + u32(tiff + 4);
        if (ifd + 2 > bytes.length) {
          return 1;
        }
        const count = u16(ifd);
        for (let i = 0; i < count; i += 1) {
          const entry = ifd + 2 + i * 12;
          if (entry + 12 > bytes.length) {
            return 1;
          }
          if (u16(entry) === 0x0112) {
            const value = u16(entry + 8);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
        return 1;
      }
    }
    at += 2 + length;
  }
  return 1;
}
