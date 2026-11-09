import { describe, expect, it } from "vitest";
import { cleanBlockDesign } from "@mycanvas/shared";
import { convertSlots, slotProblems, variantFor } from "./catalog";
import { readPlannedPart, repairPlan } from "./plan";
import { figure, labelled, planWithRules } from "./rules";

const content = `# Finanzas desde el día uno
**No necesitas un CFO para empezar.**

## Cómo empezar
1. Separa cuentas: la personal y la del negocio.
2. Registra cada gasto: cada semana, sin excepciones.
3. Cierra el mes: compara lo previsto con lo real.

## Lo que importa
- Caja: el dinero que tienes hoy.
- Margen: lo que te queda de cada venta.
- Runway: cuántos meses aguantas.

> “El dinero es un idioma.” — Ana Pérez, fundadora

## En cifras
72% de las startups fallan por caja
3x más supervivencia con un presupuesto mensual`;

describe("planWithRules", () => {
  const parts = planWithRules(content);

  it("reads the content's structure into blocks", () => {
    expect(parts.map((part) => part.block)).toEqual(["cover", "steps", "cards", "quote", "stats"]);
    expect(parts[0]?.slots).toEqual({ title: "Finanzas desde el día uno", subtitle: "No necesitas un CFO para empezar." });
    expect(parts[1]?.slots.items?.[0]).toEqual({ label: "Separa cuentas", text: "la personal y la del negocio." });
    expect(parts[2]?.slots.items?.map((item) => item.label)).toEqual(["Caja", "Margen", "Runway"]);
    expect(parts[3]?.slots).toEqual({ text: "El dinero es un idioma.", author: "Ana Pérez", role: "fundadora" });
    expect(parts[4]?.slots.items).toEqual([{ value: "72%", label: "de las startups fallan por caja" }, { value: "3x", label: "más supervivencia con un presupuesto mensual" }]);
  });

  it("splits a long list over pages instead of dropping items", () => {
    const list = Array.from({ length: 8 }, (_, index) => `- Point number ${String(index + 1)} of the list`).join("\n");
    const split = planWithRules(`## Many\n${list}`);
    expect(split.map((part) => part.slots.items?.length)).toEqual([4, 4]);
  });
});

describe("pictures", () => {
  it("gives a picture page the paragraph that follows it", () => {
    const parts = planWithRules("## Workspace\n![Office](office.jpg)\nA quiet place helps you think.");
    expect(parts).toEqual([{ block: "pictureText", slots: { title: "Workspace", image: "office.jpg", imageQuery: "Office", text: "A quiet place helps you think." } }]);
  });
});

describe("helpers", () => {
  it("finds labels and figures", () => {
    expect(labelled("Caja: el dinero que tienes")).toEqual({ label: "Caja", text: "el dinero que tienes" });
    expect(labelled("Just a sentence without a label")).toBeNull();
    expect(figure("1.200 personas formadas")).toEqual({ value: "1.200", label: "personas formadas" });
    expect(figure("Sin cifras aquí")).toBeNull();
  });
});

describe("checking and repairing AI answers", () => {
  it("reports broken limits in words the AI can act on", () => {
    expect(slotProblems("steps", { title: "Hi", items: [{ label: "x".repeat(30) }] })).toEqual([
      "\"items\" needs 2 to 5 entries, has 1",
      "items[0].label has 30 characters; at most 22",
    ]);
  });

  it("drops unknown blocks and invented pictures", () => {
    expect(readPlannedPart({ block: "pyramid", slots: {} }, new Set())).toBeNull();
    const part = readPlannedPart({ block: "pictureText", slots: { title: "T", image: "made-up.png", items: [{ text: "x" }] } }, new Set(["real.png"]));
    expect(part).toEqual({ block: "pictureText", slots: { title: "T" } });
  });

  it("repairs what can't be drawn", () => {
    const repaired = repairPlan([
      { block: "steps", slots: { title: "One step", items: [{ label: "Only" }] } },
      { block: "stats", slots: { title: "No values", items: [{ label: "a" }, { label: "b" }] } },
      { block: "points", slots: { items: Array.from({ length: 7 }, (_, index) => ({ text: `p${String(index)}` })) } },
    ]);
    expect(repaired.map((part) => part.block)).toEqual(["statement", "points", "points", "points"]);
    expect(repaired[0]?.slots).toEqual({ kicker: "One step", text: "Only" });
    expect(repaired[2]?.slots.title).toBeUndefined();
    expect(repaired[2]?.slots.items).toHaveLength(4);
  });
});

describe("switching blocks", () => {
  it("keeps list content between list blocks", () => {
    const steps = { title: "Plan", items: [{ label: "Save", text: "every month" }, { label: "Invest", text: "the rest" }] };
    expect(convertSlots(steps, "points").slots.items).toEqual([{ text: "Save: every month" }, { text: "Invest: the rest" }]);
    expect(convertSlots(steps, "cards").slots).toEqual(steps);
    const compare = convertSlots(steps, "compare").slots;
    expect(compare.left).toEqual({ label: "Save", items: ["every month"] });
  });

  it("reports text the new block has no place for", () => {
    const { slots, leftOver } = convertSlots({ title: "Plan", items: [{ text: "one" }, { text: "two" }] }, "section");
    expect(slots).toEqual({ title: "Plan" });
    expect(leftOver).toEqual(["one", "two"]);
  });

  it("keeps variants valid for the block", () => {
    expect(variantFor("timeline", { align: "right", arrange: "grid" })).toEqual({ align: "left", accent: "plain", arrange: "list" });
  });
});

describe("cleanBlockDesign", () => {
  it("keeps known fields only", () => {
    const clean = cleanBlockDesign({
      theme: { colors: { primary: "#ABCDEF", text: "red" } },
      parts: [{ id: "a", pageId: "p", block: "nope", variant: { align: "up" }, slots: { title: "T", evil: "<x>" } }, { id: "b" }],
    });
    expect(clean?.parts).toEqual([{ id: "a", pageId: "p", block: "points", variant: { align: "left", accent: "plain" }, slots: { title: "T" } }]);
    expect(clean?.theme.colors.primary).toBe("#abcdef");
    expect(clean?.theme.colors.text).toBe("#16181d");
    expect(cleanBlockDesign("nope")).toBeUndefined();
  });
});
