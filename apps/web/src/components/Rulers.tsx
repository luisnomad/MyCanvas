import { type RefObject, useCallback, useEffect, useRef } from "react";
import { useEditorStore } from "../store/editorStore";
import { getLayerNode } from "../utils/canvas-bridge";

/** Ruler thickness in CSS px (keep in sync with .rulers-on padding). */
export const RULER_SIZE = 20;

/** Candidate label spacings in design px; the smallest that fits wins. */
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
const MIN_LABEL_GAP = 56;

interface RulersProps {
  /** Scrolling viewport; rulers redraw when it scrolls or resizes. */
  viewportRef: RefObject<HTMLDivElement | null>;
  /** The canvas box (design origin at its top-left corner). */
  boxRef: RefObject<HTMLDivElement | null>;
  scale: number;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/**
 * Top and left rulers in design px, pinned to the viewport edges. Labels
 * adapt to the zoom; the current selection's extent is highlighted.
 */
export function Rulers({ viewportRef, boxRef, scale }: RulersProps) {
  const topRef = useRef<HTMLCanvasElement | null>(null);
  const leftRef = useRef<HTMLCanvasElement | null>(null);
  const selectedLayerIds = useEditorStore((state) => state.selectedLayerIds);
  const layers = useEditorStore((state) => state.design?.layers);

  const draw = useCallback(() => {
    const viewport = viewportRef.current;
    const box = boxRef.current;
    const top = topRef.current;
    const left = leftRef.current;
    if (!viewport || !box || !top || !left) {
      return;
    }
    const wrap = viewport.getBoundingClientRect();
    const origin = box.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const colors = {
      bg: cssVar(viewport, "--surface", "#ffffff"),
      line: cssVar(viewport, "--border", "#e4e4ea"),
      text: cssVar(viewport, "--text-secondary", "#6b6b76"),
      accent: cssVar(viewport, "--accent", "#7c3aed"),
    };

    // Selection extent in design px (rendered bounds, groups included).
    let highlight: { x0: number; x1: number; y0: number; y1: number } | null = null;
    for (const id of selectedLayerIds) {
      const rect = getLayerNode(id)?.getClientRect({ skipShadow: true });
      if (!rect) {
        continue;
      }
      highlight = highlight
        ? {
            x0: Math.min(highlight.x0, rect.x),
            x1: Math.max(highlight.x1, rect.x + rect.width),
            y0: Math.min(highlight.y0, rect.y),
            y1: Math.max(highlight.y1, rect.y + rect.height),
          }
        : { x0: rect.x, x1: rect.x + rect.width, y0: rect.y, y1: rect.y + rect.height };
    }

    const step = STEPS.find((candidate) => candidate * scale >= MIN_LABEL_GAP) ?? STEPS[STEPS.length - 1] ?? 1000;
    const minor = step / (step % 5 === 0 ? 5 : step % 2 === 0 ? 2 : 1);

    // Drawn in (along, across) coordinates; the left ruler swaps axes for
    // ticks and rotates only its labels, so text never comes out mirrored.
    const paint = (canvas: HTMLCanvasElement, horizontal: boolean) => {
      const length = horizontal ? wrap.width : wrap.height;
      const cssWidth = horizontal ? length : RULER_SIZE;
      const cssHeight = horizontal ? RULER_SIZE : length;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = `${String(cssWidth)}px`;
      canvas.style.height = `${String(cssHeight)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      const alongAcross = () => {
        if (horizontal) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } else {
          ctx.setTransform(0, dpr, dpr, 0, 0, 0);
        }
      };
      alongAcross();
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, length, RULER_SIZE);
      // Screen offset of design x/y = 0 along this ruler.
      const zero = horizontal ? origin.left - wrap.left : origin.top - wrap.top;
      const toScreen = (value: number) => zero + value * scale;
      if (highlight) {
        const a = toScreen(horizontal ? highlight.x0 : highlight.y0);
        const b = toScreen(horizontal ? highlight.x1 : highlight.y1);
        ctx.fillStyle = colors.accent;
        ctx.globalAlpha = 0.22;
        ctx.fillRect(a, 0, b - a, RULER_SIZE);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = colors.text;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const labels: { at: number; text: string }[] = [];
      const first = Math.floor(-zero / scale / minor) * minor;
      const last = (length - zero) / scale;
      for (let value = first; value <= last; value += minor) {
        const at = Math.round(toScreen(value)) + 0.5;
        const major = Math.abs(value / step - Math.round(value / step)) < 1e-6;
        ctx.moveTo(at, RULER_SIZE);
        ctx.lineTo(at, major ? 4 : RULER_SIZE - 5);
        if (major) {
          labels.push({ at, text: String(Math.round(value)) });
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.line;
      ctx.beginPath();
      ctx.moveTo(0, RULER_SIZE - 0.5);
      ctx.lineTo(length, RULER_SIZE - 0.5);
      ctx.stroke();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.text;
      ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "top";
      for (const label of labels) {
        if (horizontal) {
          ctx.fillText(label.text, label.at + 3, 3);
        } else {
          // Reads bottom-to-top, like other design tools.
          ctx.save();
          ctx.translate(3, label.at - 3);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(label.text, 0, 0);
          ctx.restore();
        }
      }
    };

    paint(top, true);
    paint(left, false);
  }, [viewportRef, boxRef, scale, selectedLayerIds]);

  useEffect(() => {
    draw();
  }, [draw, layers]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const observer = new ResizeObserver(draw);
    observer.observe(viewport);
    viewport.addEventListener("scroll", draw, { passive: true });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", draw);
    const themeObserver = new MutationObserver(draw);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", draw);
      media.removeEventListener("change", draw);
      themeObserver.disconnect();
    };
  }, [viewportRef, draw]);

  return (
    <>
      <canvas ref={topRef} className="ruler ruler-top" aria-hidden="true" />
      <canvas ref={leftRef} className="ruler ruler-left" aria-hidden="true" />
      <div className="ruler-corner" aria-hidden="true" />
    </>
  );
}
