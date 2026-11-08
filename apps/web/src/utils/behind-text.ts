import Konva from "konva";
import { SceneCanvas } from "konva/lib/Canvas";
import { type BehindText } from "@mycanvas/shared";
import { useEditorStore } from "../store/editorStore";
import { getLayerNode } from "./canvas-bridge";

/** Konva name of a text layer's own glyphs (not its effect copies). */
export const TEXT_MAIN_NAME = "text-main";

type DrawFunc = (context: Konva.Context, shape: Konva.Shape) => void;

/** Draws `shape` into `context` at the shape's live absolute transform. */
function drawAt(context: Konva.Context, shape: Konva.Shape, pixelRatio: number, drawn: Konva.Shape = shape) {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = shape.getAbsoluteTransform().getMatrix();
  const raw = context._context;
  raw.save();
  raw.setTransform(a * pixelRatio, b * pixelRatio, c * pixelRatio, d * pixelRatio, e * pixelRatio, f * pixelRatio);
  (drawn.getSceneFunc() as DrawFunc).call(drawn, context, drawn);
  raw.restore();
}

/**
 * sceneFunc for the "outlined text behind subject" overlay, drawn right
 * above a subject cutout. Every visible text layer below the cutout is
 * re-drawn as an outline in its own color and font, then cut to the
 * cutout's pixels: where the subject covers a letter, the letter carries on
 * across the subject as a contour. It reads the live Konva nodes on every
 * draw, so dragging, resizing or editing the text updates it immediately.
 */
export function behindTextOutlineSceneFunc(cutoutId: string, behind: BehindText): DrawFunc {
  let buffer: SceneCanvas | null = null;
  return (context) => {
    const state = useEditorStore.getState();
    const design = state.design;
    const cutout = getLayerNode(cutoutId);
    if (!design || !(cutout instanceof Konva.Image) || !cutout.isVisible() || !cutout.image()) {
      return;
    }
    const cutoutIndex = design.layers.findIndex((layer) => layer.id === cutoutId);
    const texts = design.layers.slice(0, Math.max(0, cutoutIndex)).flatMap((layer) => {
      if (layer.type !== "text" || !layer.visible) {
        return [];
      }
      const group = getLayerNode(layer.id);
      const main = group instanceof Konva.Container ? group.findOne<Konva.Shape>(`.${TEXT_MAIN_NAME}`) : undefined;
      // Hidden while being edited in place: nothing to outline.
      return main && group?.isVisible() ? [{ layer, main }] : [];
    });
    if (texts.length === 0) {
      return;
    }

    const t = context._context.getTransform();
    const pixelRatio = Math.hypot(t.a, t.b) || 1;
    if (buffer?.getPixelRatio() !== pixelRatio || buffer.getWidth() !== design.width || buffer.getHeight() !== design.height) {
      buffer = new SceneCanvas({ width: design.width, height: design.height, pixelRatio });
    }
    const bufferContext = buffer.getContext();
    const raw = bufferContext._context;
    raw.setTransform(1, 0, 0, 1, 0, 0);
    raw.globalCompositeOperation = "source-over";
    raw.globalAlpha = 1;
    raw.clearRect(0, 0, buffer._canvas.width, buffer._canvas.height);

    // 1. Outlined copies of the text, at the text's live position.
    for (const { layer, main } of texts) {
      const [a = 1, b = 0] = main.getAbsoluteTransform().getMatrix();
      const scale = Math.hypot(a, b) || 1;
      const outline = main.clone({
        fillEnabled: false,
        strokeEnabled: true,
        stroke: layer.fill,
        // Stroke scales with the text; divide so the width is in design px.
        strokeWidth: behind.width / scale,
        shadowEnabled: false,
        filters: [],
      }) as Konva.Shape;
      raw.globalAlpha = layer.opacity;
      drawAt(bufferContext, main, pixelRatio, outline);
      outline.destroy();
    }

    // 2. Keep only the part over the subject's pixels.
    raw.globalAlpha = 1;
    raw.globalCompositeOperation = "destination-in";
    drawAt(bufferContext, cutout, pixelRatio);
    raw.globalCompositeOperation = "source-over";

    // 3. Paint it over the cutout (this shape sits at the layer origin).
    context._context.drawImage(buffer._canvas, 0, 0, design.width, design.height);
  };
}
