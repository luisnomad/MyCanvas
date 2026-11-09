import { describe, expect, it } from "vitest";
import { parseContent } from "./content-markdown";

describe("parseContent", () => {
  it("reads every block kind", () => {
    const items = parseContent([
      "# FINANZAS",
      "# DESDE EL",
      "# DÍA UNO",
      "",
      "**No necesitas un CFO desde el primer día.**",
      "",
      "## 1. CUMPLIR",
      "",
      "Contabilidad, impuestos",
      "y obligaciones al día.",
      "",
      "> SEÑAL CLAVE · Cierra cada mes:",
      "> detectar errores pronto.",
      "",
      "![Calculadora](abc123.png)",
      "",
      "---",
      "",
      "- uno",
      "- dos",
    ].join("\n"));
    expect(items).toEqual([
      { kind: "title", text: "FINANZAS\nDESDE EL\nDÍA UNO" },
      { kind: "lead", text: "No necesitas un CFO desde el primer día." },
      { kind: "heading", text: "1. CUMPLIR" },
      { kind: "body", text: "Contabilidad, impuestos y obligaciones al día." },
      { kind: "callout", text: "SEÑAL CLAVE · Cierra cada mes: detectar errores pronto." },
      { kind: "image", text: "Calculadora", asset: "abc123.png" },
      { kind: "pageBreak" },
      { kind: "body", text: "• uno\n• dos" },
    ]);
  });

  it("treats anything unrecognised as body text and drops inline emphasis", () => {
    expect(parseContent("Hello **world** and __you__\r\n\r\n#hashtag")).toEqual([
      { kind: "body", text: "Hello world and you" },
      { kind: "body", text: "#hashtag" },
    ]);
  });

  it("keeps paragraph breaks inside a callout", () => {
    expect(parseContent("> First\n>\n> Second")).toEqual([{ kind: "callout", text: "First\nSecond" }]);
  });

  it("accepts image paths with an /assets/ prefix", () => {
    expect(parseContent("![x](/assets/f.png)")).toEqual([{ kind: "image", text: "x", asset: "f.png" }]);
  });

  it("ignores empty input", () => {
    expect(parseContent("\n\n  \n")).toEqual([]);
  });
});
