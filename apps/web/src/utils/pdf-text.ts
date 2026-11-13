import { type TextEffect, type TextLayer } from "@mycanvas/shared";
import { type PathCommand, arcCommands, parseCssColor } from "./pdf-vector";

/**
 * Text geometry for PDF export (pure: no Konva, no pdf-lib).
 *
 * Curved text in the editor is a Konva.TextPath riding the arc that
 * LayerNode's curveArcData builds; this module rebuilds that arc and
 * places glyphs the way Konva.TextPath._setTextData does (its 1°-chord
 * path length included, so the same glyphs survive at the path end).
 * The straight-text background bands and the echo/glitch offsets come
 * from the same formulas LayerNode uses.
 */

/** A circular arc in y-down space; `sweep` is signed (positive = clockwise on screen). */
export interface CurveArc {
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  sweep: number;
}

/**
 * The arc of curveArcData: W is the flat text width, the text rides a
 * circle of radius W/Θ with Θ = (|curve|/100)·2π. Positive curves arch
 * (circle below the text), negative ones smile (circle above, read
 * left-to-right so the sweep is reversed). Null for straight text.
 */
export function curveArc(textWidth: number, fontSize: number, curve: number): CurveArc | null {
  if (curve === 0 || !(textWidth > 0)) {
    return null;
  }
  const theta = Math.min(1, Math.abs(curve) / 100) * 2 * Math.PI;
  const radius = textWidth / theta;
  const half = theta / 2;
  const cx = textWidth / 2;
  const cy = curve > 0 ? radius + fontSize * 0.8 : fontSize * 0.8 - radius * Math.cos(half);
  return curve > 0
    ? { cx, cy, radius, startAngle: -Math.PI / 2 - half, sweep: theta }
    : { cx, cy, radius, startAngle: Math.PI / 2 + half, sweep: -theta };
}

export function arcPoint(arc: CurveArc, angle: number): { x: number; y: number } {
  return { x: arc.cx + arc.radius * Math.cos(angle), y: arc.cy + arc.radius * Math.sin(angle) };
}

/** Konva.Path's length of an arc: chords at 1° steps (slightly under the true length). */
export function konvaArcLength(arc: CurveArc): number {
  const start = arc.startAngle;
  const end = start + arc.sweep;
  let inc = Math.PI / 180;
  if (Math.abs(start - end) < inc) {
    inc = Math.abs(start - end);
  }
  let length = 0;
  let previous = arcPoint(arc, start);
  const step = (t: number) => {
    const next = arcPoint(arc, t);
    length += Math.hypot(next.x - previous.x, next.y - previous.y);
    previous = next;
  };
  if (arc.sweep < 0) {
    for (let t = start - inc; t > end; t -= inc) {
      step(t);
    }
  } else {
    for (let t = start + inc; t < end; t += inc) {
      step(t);
    }
  }
  step(end);
  return length;
}

/** Konva's point at `length` along the arc: the angle grows linearly with length over its own path length. */
export function arcPointAtLength(arc: CurveArc, length: number, pathLength: number): { x: number; y: number } {
  return arcPoint(arc, arc.startAngle + (arc.sweep * length) / pathLength);
}

export interface GlyphPlacement {
  text: string;
  /** Glyph origin (start of its advance, on the path), layer-local. */
  x: number;
  y: number;
  /** Rotation along the chord to the glyph's end, radians, y-down. */
  rotation: number;
}

/**
 * Where Konva.TextPath puts each character (left-aligned, no kerning
 * function): the glyph starts at its running offset along the path and
 * is rotated along the chord to its end. `chars` carry the browser's
 * per-character widths; `fullTextWidth` is the whole string's measured
 * width (the difference is kerning slack, which lets the last chord end
 * on the path). A character that starts past the path is dropped, as in
 * the editor; one whose end falls past it beyond that slack ends the text.
 */
export function curvedGlyphs(
  chars: { text: string; width: number }[],
  fullTextWidth: number,
  letterSpacing: number,
  arc: CurveArc,
): GlyphPlacement[] {
  const pathLength = konvaArcLength(arc);
  const sum = chars.reduce((total, char) => total + char.width, 0);
  const kerningAdjustment = Math.max(0, sum - fullTextWidth);
  const glyphs: GlyphPlacement[] = [];
  let offset = 0;
  for (const char of chars) {
    if (offset > pathLength) {
      break;
    }
    const start = arcPointAtLength(arc, offset, pathLength);
    const glyphWidth = char.width + letterSpacing;
    const endLength = offset + glyphWidth;
    let endAt = endLength;
    if (endLength > pathLength) {
      if (endLength - pathLength > kerningAdjustment) {
        break;
      }
      endAt = pathLength;
    }
    const end = arcPointAtLength(arc, endAt, pathLength);
    glyphs.push({ text: char.text, x: start.x, y: start.y, rotation: Math.atan2(end.y - start.y, end.x - start.x) });
    offset += glyphWidth;
  }
  return glyphs;
}

/** The arc as a path (for the curved background band). */
export function arcPath(arc: CurveArc): PathCommand[] {
  const start = arcPoint(arc, arc.startAngle);
  return [{ op: "M", x: start.x, y: start.y }, ...arcCommands(arc.cx, arc.cy, arc.radius, arc.startAngle, arc.startAngle + arc.sweep)];
}

/** The (dx, dy) of an effect with a distance and angle; zero otherwise. */
export function effectOffset(effect: TextEffect): { dx: number; dy: number } {
  if (!("distance" in effect) || !("angle" in effect)) {
    return { dx: 0, dy: 0 };
  }
  const radians = (effect.angle * Math.PI) / 180;
  return { dx: effect.distance * Math.cos(radians), dy: effect.distance * Math.sin(radians) };
}

export interface Band {
  /** Stroke centerline, layer-local. */
  x0: number;
  y: number;
  x1: number;
  width: number;
  cap: "butt" | "round" | "square";
}

/** Line cap of the background effect by its roundness, as LayerNode picks it. */
export function bandCap(roundness: number): Band["cap"] {
  return roundness >= 50 ? "round" : roundness >= 20 ? "square" : "butt";
}

/**
 * The background effect under straight text: one thick line per text line,
 * centered on the line, as wide as the line and aligned like it.
 */
export function straightBands(
  lineWidths: number[],
  layer: Pick<TextLayer, "wrapWidth" | "align" | "fontSize" | "lineHeight">,
  effect: Extract<TextEffect, { type: "background" }>,
): Band[] {
  const totalWidth = layer.wrapWidth > 0 ? layer.wrapWidth : Math.max(...lineWidths, 0);
  const lineHeightPx = layer.fontSize * layer.lineHeight;
  const width = lineHeightPx + effect.spread;
  const cap = bandCap(effect.roundness);
  return lineWidths.map((lineWidth, index) => {
    const x0 = layer.align === "center" ? (totalWidth - lineWidth) / 2 : layer.align === "right" ? totalWidth - lineWidth : 0;
    return { x0, y: index * lineHeightPx + lineHeightPx / 2, x1: x0 + lineWidth, width, cap };
  });
}

/** Why a text layer can't be real PDF text yet, or null when it can (font permitting). */
export function textFallbackReason(layer: TextLayer): string | null {
  const fill = parseCssColor(layer.fill);
  if (!fill) {
    return "fill color";
  }
  if (Math.abs(layer.curve ?? 0) >= 100) {
    // A full circle is a degenerate SVG arc in the editor (start = end): it draws
    // only stray glyphs there, so the picture is the faithful export.
    return "full circle";
  }
  const effect = layer.effect ?? { type: "none" as const };
  switch (effect.type) {
    case "none":
      return null;
    case "outline":
    case "echo":
    case "background":
      return parseCssColor(effect.color) ? null : "effect color";
    case "glitch":
    // Shadow and glow are soft: the exporter draws them as a picture under the text.
    case "shadow":
    case "glow":
      return null;
  }
}
