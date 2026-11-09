import { describe, expect, it } from "vitest";
import { parseContent } from "../content-markdown";
import { paragraphsToMarkdown } from "./classify";

describe("paragraphsToMarkdown", () => {
  it("reads a hand-styled Word document (bold lines, no heading styles)", () => {
    const { markdown, stats } = paragraphsToMarkdown([
      { text: "FINANZAS DESDE EL DÍA UNO", bold: true },
      { text: "No necesitas un CFO desde el primer día. Necesitas pensar en Finanzas desde el primer día.", bold: true },
      { text: "Las finanzas son el idioma de los negocios." },
      { text: "1", bold: true },
      { text: "CUMPLIR", bold: true },
      { text: "Contabilidad, impuestos y obligaciones al día." },
    ], { detectTitle: true });
    expect(markdown).toBe([
      "# FINANZAS DESDE EL DÍA UNO",
      "",
      "**No necesitas un CFO desde el primer día. Necesitas pensar en Finanzas desde el primer día.**",
      "",
      "Las finanzas son el idioma de los negocios.",
      "",
      "## 1. CUMPLIR",
      "",
      "Contabilidad, impuestos y obligaciones al día.",
      "",
    ].join("\n"));
    expect(stats).toEqual({ headings: 1, paragraphs: 3, images: 0, hasTitle: true });
  });

  it("reads slides by font size: big bold = heading, bold a bit bigger = lead, body, small", () => {
    const { markdown } = paragraphsToMarkdown([
      { text: "01. Finanzas desde el día uno", size: 23, bold: true },
      { text: "¿Para qué ocuparte de las finanzas?", size: 18, bold: true },
      { text: "Las finanzas son el idioma de los negocios.", size: 15.2 },
      { text: "ERROR FRECUENTE: enamorarte del producto y confundir demanda con viabilidad.", size: 14.5 },
      { text: "IDEA CLAVE: Finanzas no es un departamento; es una capacidad.", size: 14.5 },
      { role: "pageBreak", text: "" },
      { text: "02. Cumplir", size: 23, bold: true },
    ], { detectTitle: false });
    expect(parseContent(markdown).map((item) => item.kind)).toEqual(["heading", "lead", "body", "body", "body", "pageBreak", "heading"]);
  });

  it("keeps explicit roles, lists, quotes and images", () => {
    const { markdown } = paragraphsToMarkdown([
      { role: "title", text: "Report" },
      { role: "heading", text: "Intro" },
      { role: "listItem", text: "one" },
      { role: "listItem", text: "two" },
      { role: "quote", text: "Remember this" },
      { role: "image", text: "Chart [1]", asset: "abc.png" },
    ], { detectTitle: true });
    expect(markdown).toBe("# Report\n\n## Intro\n\n- one\n- two\n\n> Remember this\n\n![Chart 1](abc.png)\n");
  });

  it("escapes body text that looks like syntax, and the parser reads it back as text", () => {
    const { markdown } = paragraphsToMarkdown([
      { text: "1. Not a list, just a sentence that starts with a number." },
      { text: "# not a title" },
      { text: "---" },
    ], { detectTitle: true });
    expect(parseContent(markdown)).toEqual([
      { kind: "body", text: "1. Not a list, just a sentence that starts with a number." },
      { kind: "body", text: "# not a title" },
      { kind: "body", text: "---" },
    ]);
  });

  it("joins a title set on several lines into one title", () => {
    const { markdown } = paragraphsToMarkdown([
      { text: "CÓMO TRASPASAR UN", size: 40, bold: true },
      { text: "NEGOCIO EN 9 PASOS", size: 40, bold: true },
      { text: "Traspasar un negocio es un proceso que requiere preparación y tiempo.", size: 12 },
      { text: "Sigue estos 9 pasos para ordenar la información y planificar el relevo.", size: 12 },
    ], { detectTitle: true });
    expect(parseContent(markdown)[0]).toEqual({ kind: "title", text: "CÓMO TRASPASAR UN\nNEGOCIO EN 9 PASOS" });
  });

  it("drops page breaks at the edges and doubled ones", () => {
    const { markdown } = paragraphsToMarkdown([
      { role: "pageBreak", text: "" },
      { text: "A" },
      { role: "pageBreak", text: "" },
      { role: "pageBreak", text: "" },
      { text: "B" },
      { role: "pageBreak", text: "" },
    ], { detectTitle: false });
    expect(markdown).toBe("A\n\n---\n\nB\n");
  });
});
