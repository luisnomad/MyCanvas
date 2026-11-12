import Konva from "konva";
import { type ContentBox, type FrameContent, type FrameShape, coverContent, frameContentBox, recoverContent } from "@mycanvas/shared";
import { getCachedImageSize } from "../hooks/useImage";
import { useEditorStore } from "../store/editorStore";
import { roundedPolygonPath, shapePoints, traceRoundedPolygon } from "./rounded-path";

export { clampContent, coverContent, coverScale, recoverContent } from "@mycanvas/shared";

/**
 * Frame (image container) helpers: cover-fit math for content placement and
 * the shared geometry (clip path, drawer thumbnails). Shapes reuse the
 * rounded-polygon helper so corner radius works on frames too.
 */

/** Name of the group inside a frame that holds the photo (its own space). */
export const FRAME_CONTENT_NAME = "frame-content";

/** The photo's holder inside a frame node, if the frame has a photo. */
export function frameContentHolder<T extends Konva.Container>(frame: T): Konva.Group | undefined {
  const holder = frame.findOne(`.${FRAME_CONTENT_NAME}`);
  return holder instanceof Konva.Group ? holder : undefined;
}

/**
 * Lays the photo's holder out for the frame node's live size and rotation
 * (during a drag, before the store has the new values). Returns the box it
 * had and the box it has now, so callers can re-cover the photo.
 */
export function syncContentHolder<T extends Konva.Container>(
  frame: T,
  contentRotation: number | undefined,
): { before: ContentBox; after: ContentBox } | null {
  const holder = frameContentHolder(frame);
  if (!holder) {
    return null;
  }
  const before = { width: holder.width(), height: holder.height(), angle: holder.rotation() };
  const after = frameContentBox({ width: frame.width(), height: frame.height(), rotation: frame.rotation(), contentRotation });
  holder.setAttrs({
    x: frame.width() / 2,
    y: frame.height() / 2,
    offsetX: after.width / 2,
    offsetY: after.height / 2,
    width: after.width,
    height: after.height,
    rotation: after.angle,
  });
  return { before, after };
}

/**
 * Live follow-up while a frame is resized or rotated: re-lays the holder and
 * re-covers the photo for the new box (zoom ratio and visible center kept).
 */
export function followFrameBox<T extends Konva.Container>(frame: T, content: FrameContent | undefined, contentRotation: number | undefined): void {
  const synced = syncContentHolder(frame, contentRotation);
  const imageNode = frame.findOne("Image");
  if (!content || !synced || !(imageNode instanceof Konva.Image)) {
    return;
  }
  const natural = getCachedImageSize(`/assets/${content.asset}`);
  if (!natural) {
    return;
  }
  const next = recoverContent(
    { asset: content.asset, offsetX: imageNode.x(), offsetY: imageNode.y(), scale: imageNode.scaleX() },
    natural.width,
    natural.height,
    synced.before.width,
    synced.before.height,
    synced.after.width,
    synced.after.height,
  );
  imageNode.x(next.offsetX);
  imageNode.y(next.offsetY);
  imageNode.scaleX(next.scale);
  imageNode.scaleY(next.scale);
}

/** dataTransfer MIME for Uploads-panel asset drags (drop = fill a frame). */
export const ASSET_DRAG_MIME = "application/x-mycanvas-asset";

/**
 * The asset id of the in-flight Uploads drag. dataTransfer.getData() is
 * unreadable during dragover (only types), so the frame/background drop
 * previews learn WHICH bitmap is dragged through this stash instead. Set on
 * dragstart, cleared on dragend.
 */
let currentAssetDrag: string | null = null;

export function setCurrentAssetDrag(asset: string | null): void {
  currentAssetDrag = asset;
}

export function getCurrentAssetDrag(): string | null {
  return currentAssetDrag;
}

/**
 * Traces the frame's shape path onto a canvas context (Konva clipFunc). Reads
 * like the shape renderers: rect (+corner radius), circle, or the polygonal
 * set via the rounded-polygon tracer.
 */
export function traceFramePath(
  ctx: Pick<
    CanvasRenderingContext2D,
    "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "closePath" | "ellipse" | "rect"
  >,
  shape: FrameShape,
  width: number,
  height: number,
  cornerRadius: number,
): void {
  if (shape === "circle") {
    ctx.beginPath();
    ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  if (shape === "rect") {
    if (cornerRadius <= 0) {
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.closePath();
      return;
    }
    traceRoundedPolygon(ctx, [0, 0, width, 0, width, height, 0, height], cornerRadius);
    return;
  }
  traceRoundedPolygon(ctx, shapePoints(shape, width, height), cornerRadius);
}

/** SVG path data for the frame shape — drawer thumbnails. */
export function framePathData(shape: FrameShape, width: number, height: number, cornerRadius: number): string {
  if (shape === "circle") {
    // Two-arc ellipse.
    return `M 0 ${String(height / 2)} A ${String(width / 2)} ${String(height / 2)} 0 0 1 ${String(width)} ${String(height / 2)} A ${String(width / 2)} ${String(height / 2)} 0 0 1 0 ${String(height / 2)} Z`;
  }
  if (shape === "rect") {
    return roundedPolygonPath([0, 0, width, 0, width, height, 0, height], cornerRadius);
  }
  return roundedPolygonPath(shapePoints(shape, width, height), cornerRadius);
}

function loadImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    };
    img.onerror = () => {
      reject(new Error(`Failed to load ${url}`));
    };
    img.src = url;
  });
}

/**
 * Fills a frame with an asset (cover-fit, centered) — one history entry.
 * Used by all three fill paths: Uploads drag, filesystem drop, inspector
 * picker. Locked/non-frame layers are rejected by the store guard / type check.
 */
export async function fillFrame(layerId: string, asset: string): Promise<void> {
  const store = useEditorStore.getState();
  const layer = store.design?.layers.find((entry) => entry.id === layerId);
  if (layer?.type !== "frame") {
    return;
  }
  const size = getCachedImageSize(`/assets/${asset}`) ?? (await loadImageSize(`/assets/${asset}`));
  const box = frameContentBox(layer);
  store.updateLayer(layerId, {
    content: coverContent(asset, size.width, size.height, box.width, box.height),
  });
}
