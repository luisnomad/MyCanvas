import type Konva from "konva";
import { Circle } from "react-konva";
import { type LineLayer, controlForMidpoint, curveMidpoint } from "@mycanvas/shared";
import { useEditorStore } from "../store/editorStore";

/**
 * The round handle on a selected line's middle: drag it to bend the line
 * into a curve (one undo step), double-click it to straighten the line.
 * Lives in the overlay layer, in design coordinates.
 */
export function LineBendHandle({ layer, node, scale, color }: { layer: LineLayer; node: Konva.Node; scale: number; color: string }) {
  const updateLayer = useEditorStore((state) => state.updateLayer);
  const commitTransient = useEditorStore((state) => state.commitTransient);
  const [mx, my] = curveMidpoint(layer.points, layer.control);
  const at = node.getAbsoluteTransform().point({ x: mx, y: my });

  const toControl = (handle: Konva.Node): [number, number] => {
    const local = node.getAbsoluteTransform().copy().invert().point(handle.position());
    return controlForMidpoint(layer.points, [local.x, local.y]);
  };

  return (
    <Circle
      name="line-bend-handle"
      x={at.x}
      y={at.y}
      radius={6 / scale}
      hitStrokeWidth={10 / scale}
      fill="#ffffff"
      stroke={color}
      strokeWidth={2 / scale}
      draggable
      onMouseEnter={(e) => {
        const container = e.target.getStage()?.container();
        if (container) {
          container.style.cursor = "grab";
        }
      }}
      onMouseLeave={(e) => {
        const container = e.target.getStage()?.container();
        if (container) {
          container.style.cursor = "";
        }
      }}
      onMouseDown={(e) => {
        // Keep the stage from treating this as a click on empty canvas.
        e.cancelBubble = true;
      }}
      onDragMove={(e) => {
        updateLayer(layer.id, { control: toControl(e.target) }, true);
      }}
      onDragEnd={(e) => {
        updateLayer(layer.id, { control: toControl(e.target) }, true);
        commitTransient();
      }}
      onDblClick={(e) => {
        e.cancelBubble = true;
        updateLayer(layer.id, { control: undefined });
      }}
    />
  );
}
