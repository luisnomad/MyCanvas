import { describe, expect, it } from "vitest";
import { type TextBlock } from "./analyze-pdf";
import { classifyExample } from "./classify-example";

function block(text: string, y: number, size: number, family: string, weight: number, color: string, extra: Partial<TextBlock> = {}): TextBlock {
  return {
    text,
    x: 85,
    y,
    width: 400,
    height: size * 1.2,
    size,
    font: { family, use: family, exact: true, weight, italic: false },
    color,
    lineHeight: 1.2,
    baseline: y + size * 0.85,
    lines: 1,
    ...extra,
  };
}

const body = "Las finanzas son el idioma de los negocios: te ayudan a entender si tu modelo funciona.";

describe("classifyExample", () => {
  it("finds title, lead, heading, body and callout by look", () => {
    const page = {
      width: 595,
      height: 842,
      blocks: [
        block("FINANZAS", 44, 64, "Bodoni Moda", 900, "#e8d06c"),
        block("DESDE EL", 100, 57, "Bodoni Moda", 900, "#e8d06c"),
        block("No necesitas un CFO desde el primer día. Necesitas pensar en finanzas.", 256, 21.5, "Roboto Condensed", 700, "#ffffff"),
        block(body, 318, 18.5, "Roboto Condensed", 400, "#ffffff"),
        block("1. CUMPLIR", 404, 19.5, "Roboto Condensed", 700, "#ffffff"),
        block(body, 439, 18.5, "Roboto Condensed", 400, "#ffffff"),
        block("SEÑAL CLAVE · Cierra cada mes.", 479, 17.5, "Roboto Condensed", 700, "#424ddb", { box: { x: 81, y: 469, width: 448, height: 60, color: "#e8d06c" } }),
        block("2. ENTENDER", 560, 19.5, "Roboto Condensed", 700, "#ffffff"),
        block(body, 600, 18.5, "Roboto Condensed", 400, "#ffffff"),
        block("www.example.org", 820, 9, "Roboto Condensed", 400, "#ffffff"),
      ],
    };
    const roles = classifyExample([page]);
    expect(roles.samples.title?.text).toBe("FINANZAS\nDESDE EL");
    // Lines fitted to width in different sizes: the smaller one, so new titles don't overflow.
    expect(roles.samples.title?.size).toBe(57);
    expect(roles.samples.lead?.block.font.weight).toBe(700);
    expect(roles.samples.lead?.block.size).toBe(21.5);
    expect(roles.samples.heading?.text).toBe("1. CUMPLIR");
    expect(roles.samples.body?.block.font.weight).toBe(400);
    expect(roles.samples.callout?.block.box?.color).toBe("#e8d06c");
    expect(roles.furniture.map((entry) => entry.block.text)).toEqual(["www.example.org"]);
  });
});
