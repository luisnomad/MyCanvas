import {
  type FrameLayer,
  type FrameShape,
  type Layer,
  type LayerType,
  type LineLayer,
  type RectLayer,
  type ShapeKind,
  type ShapeLayer,
  type TextLayer,
  defaultShadow,
  defaultStroke,
} from "./design";

/*
 * New-layer defaults shared by the editor's "add" buttons and the agent API,
 * so a layer looks the same whichever side made it. Image layers need the
 * picture's size, so their geometry is worked out by the caller.
 */

interface CanvasSize {
  width: number;
  height: number;
}

function base(id: string, name: string, x: number, y: number) {
  return { id, name, x, y, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true };
}

export function newTextLayer(id: string, canvas: CanvasSize, fontFamily = "Inter"): TextLayer {
  return {
    ...base(id, "Text", Math.round(canvas.width / 2), Math.round(canvas.height / 2)),
    type: "text",
    text: "Your text here",
    fontFamily,
    fontSize: 64,
    fontStyle: "normal",
    fill: "#ffffff",
    align: "left",
    lineHeight: 1.2,
    letterSpacing: 0,
    wrapWidth: 0,
    curve: 0,
    effect: { type: "none" },
    shadow: defaultShadow(),
    stroke: defaultStroke(),
  };
}

export function newRectLayer(id: string, canvas: CanvasSize): RectLayer {
  const width = Math.round(canvas.width / 3);
  const height = Math.round(canvas.height / 3);
  return {
    ...base(id, "Rectangle", Math.round((canvas.width - width) / 2), Math.round((canvas.height - height) / 2)),
    type: "rect",
    width,
    height,
    fill: "#7c3aed",
    cornerRadius: 0,
    stroke: defaultStroke(),
    shadow: defaultShadow(),
  };
}

export function newLineLayer(id: string, canvas: CanvasSize): LineLayer {
  const length = Math.round(canvas.width / 3);
  return {
    ...base(id, "Line", Math.round((canvas.width - length) / 2), Math.round(canvas.height / 2)),
    type: "line",
    points: [0, 0, length, 0],
    strokeColor: "#7c3aed",
    strokeWidth: 4,
    lineCap: "round",
    shadow: defaultShadow(),
  };
}

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  triangle: "Triangle",
  hexagon: "Hexagon",
  circle: "Circle",
  semicircle: "Semicircle",
  star: "Star",
};

export function newShapeLayer(id: string, canvas: CanvasSize, shape: ShapeKind, name = SHAPE_NAMES[shape]): ShapeLayer {
  const width = Math.round(canvas.width / 4);
  const height = Math.round(canvas.height / 4);
  return {
    ...base(id, name, Math.round((canvas.width - width) / 2), Math.round((canvas.height - height) / 2)),
    type: "shape",
    shape,
    width,
    height,
    fill: "#7c3aed",
    stroke: defaultStroke(),
    shadow: defaultShadow(),
  };
}

export function newFrameLayer(id: string, canvas: CanvasSize, shape: FrameShape, name = "Frame", cornerRadius = 0): FrameLayer {
  const width = Math.round(canvas.width / 3.2);
  const height = Math.round(canvas.height / 3.2);
  return {
    ...base(id, name, Math.round((canvas.width - width) / 2), Math.round((canvas.height - height) / 2)),
    type: "frame",
    shape,
    width,
    height,
    cornerRadius,
  };
}

/** Default layer of a type, for every type but images (those need a picture). */
export function newLayer(type: Exclude<LayerType, "image">, id: string, canvas: CanvasSize): Layer {
  switch (type) {
    case "text":
      return newTextLayer(id, canvas);
    case "rect":
      return newRectLayer(id, canvas);
    case "line":
      return newLineLayer(id, canvas);
    case "shape":
      return newShapeLayer(id, canvas, "circle");
    case "frame":
      return newFrameLayer(id, canvas, "rect");
  }
}
