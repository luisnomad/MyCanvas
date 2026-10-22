import { type GradientFill } from "@mycanvas/shared";

/** Curated starting points for the gradient picker. */
export const GRADIENT_PRESETS: GradientFill[] = [
  { type: "linear", angle: 135, stops: [{ offset: 0, color: "#7c3aed" }, { offset: 1, color: "#ec4899" }] },
  { type: "linear", angle: 135, stops: [{ offset: 0, color: "#f97316" }, { offset: 1, color: "#facc15" }] },
  { type: "linear", angle: 90, stops: [{ offset: 0, color: "#0ea5e9" }, { offset: 1, color: "#1e3a8a" }] },
  { type: "linear", angle: 45, stops: [{ offset: 0, color: "#10b981" }, { offset: 1, color: "#a3e635" }] },
  { type: "linear", angle: 90, stops: [{ offset: 0, color: "#111827" }, { offset: 1, color: "#4b5563" }] },
  { type: "linear", angle: 120, stops: [{ offset: 0, color: "#fb7185" }, { offset: 0.5, color: "#f59e0b" }, { offset: 1, color: "#fde68a" }] },
  { type: "radial", angle: 0, stops: [{ offset: 0, color: "#fef3c7" }, { offset: 1, color: "#f97316" }] },
  { type: "radial", angle: 0, stops: [{ offset: 0, color: "#312e81" }, { offset: 1, color: "#020617" }] },
];

/** CSS equivalent, for swatches and previews. */
export function gradientCss(gradient: GradientFill): string {
  const stops = gradient.stops.map((stop) => `${stop.color} ${String(Math.round(stop.offset * 100))}%`).join(", ");
  return gradient.type === "radial"
    ? `radial-gradient(circle, ${stops})`
    // CSS 0deg points up; ours points right.
    : `linear-gradient(${String(gradient.angle + 90)}deg, ${stops})`;
}

/**
 * Konva fill props painting `gradient` across a w×h box whose top-left sits
 * at (originX, originY) in the shape's local space. Empty when absent, so the
 * solid fill applies.
 */
export function gradientFillProps(gradient: GradientFill | undefined, w: number, h: number, originX = 0, originY = 0) {
  if (!gradient || gradient.stops.length < 2) {
    return {};
  }
  const colorStops = gradient.stops.flatMap((stop) => [stop.offset, stop.color]);
  const cx = originX + w / 2;
  const cy = originY + h / 2;
  if (gradient.type === "radial") {
    return {
      fillPriority: "radial-gradient",
      fillRadialGradientStartPoint: { x: cx, y: cy },
      fillRadialGradientEndPoint: { x: cx, y: cy },
      fillRadialGradientStartRadius: 0,
      fillRadialGradientEndRadius: Math.hypot(w, h) / 2,
      fillRadialGradientColorStops: colorStops,
    };
  }
  const radians = (gradient.angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  // Half the box's extent along the direction, so the stops span it exactly.
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return {
    fillPriority: "linear-gradient",
    fillLinearGradientStartPoint: { x: cx - dx * half, y: cy - dy * half },
    fillLinearGradientEndPoint: { x: cx + dx * half, y: cy + dy * half },
    fillLinearGradientColorStops: colorStops,
  };
}
