/*
 * Curved lines: a line with a `control` point is a quadratic Bézier from its
 * first point to its second, pulled towards the control point. Editors show
 * a handle on the curve's middle (the point at t = 0.5), which is easier to
 * aim at than the control point itself (that lies off the curve).
 */

type Points = readonly [number, number, number, number];
type Point = readonly [number, number];

/** The point on the curve halfway along (t = 0.5). */
export function curveMidpoint(points: Points, control?: Point): [number, number] {
  const [x1, y1, x2, y2] = points;
  if (!control) {
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  }
  return [(x1 + 2 * control[0] + x2) / 4, (y1 + 2 * control[1] + y2) / 4];
}

/** The control point that puts the curve's middle at `mid`. */
export function controlForMidpoint(points: Points, mid: Point): [number, number] {
  const [x1, y1, x2, y2] = points;
  return [2 * mid[0] - (x1 + x2) / 2, 2 * mid[1] - (y1 + y2) / 2];
}

/** The same curve as cubic Bézier points (start, c1, c2, end), for canvas drawing. */
export function cubicPoints(points: Points, control: Point): number[] {
  const [x1, y1, x2, y2] = points;
  const [cx, cy] = control;
  return [
    x1, y1,
    x1 + (2 / 3) * (cx - x1), y1 + (2 / 3) * (cy - y1),
    x2 + (2 / 3) * (cx - x2), y2 + (2 / 3) * (cy - y2),
    x2, y2,
  ];
}

/** Bounding box of the line or curve (stroke width not included). */
export function curveBounds(points: Points, control?: Point): { left: number; top: number; right: number; bottom: number } {
  const [x1, y1, x2, y2] = points;
  const xs = [x1, x2];
  const ys = [y1, y2];
  if (control) {
    // A quadratic's extreme on each axis is at t = (p0 − c) / (p0 − 2c + p1).
    const extreme = (p0: number, c: number, p1: number): number | null => {
      const denom = p0 - 2 * c + p1;
      if (denom === 0) {
        return null;
      }
      const t = (p0 - c) / denom;
      return t > 0 && t < 1 ? (1 - t) ** 2 * p0 + 2 * (1 - t) * t * c + t * t * p1 : null;
    };
    const ex = extreme(x1, control[0], x2);
    const ey = extreme(y1, control[1], y2);
    if (ex !== null) {
      xs.push(ex);
    }
    if (ey !== null) {
      ys.push(ey);
    }
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}
