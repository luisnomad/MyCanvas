import { describe, expect, it } from "vitest";
import type { Design } from "@mycanvas/shared";
import { type PageLayout, layoutWarnings, pagesOf } from "./layout-check";

const box = (id: string, x: number, y: number, width: number, height: number, outside: boolean) =>
  ({ id, name: id, x, y, width, height, outside });

const layout: PageLayout = {
  width: 1200,
  height: 628,
  layers: [
    box("rule", 507, 708, 226, 12, true),
    box("badge", 1087, 68, 211, 211, true),
    box("orb", 820, -140, 520, 520, true),
    box("headline", 110, 190, 600, 178, false),
  ],
  missingFonts: ["Fancy Sans"],
};

describe("layout warnings", () => {
  it("flags touched layers off or partly off the page, with their drawn box, and missing fonts", () => {
    const warnings = layoutWarnings(layout, 0, new Set(["rule", "badge", "headline"]), new Set(["Fancy Sans"]));
    expect(warnings).toEqual([
      expect.objectContaining({ layer: "rule", problem: "off_page", box: { x: 507, y: 708, width: 226, height: 12 } }),
      expect.objectContaining({ layer: "badge", problem: "partly_off_page" }),
      expect.objectContaining({ problem: "missing_font", page: 0 }),
    ]);
    expect(warnings[0]?.message).toContain("1200×628");
  });

  it("leaves alone layers the batch didn't touch (e.g. a deliberate bleed made earlier)", () => {
    // Untouched layers and fonts only untouched text uses aren't mentioned again.
    const warnings = layoutWarnings(layout, 0, new Set(["headline"]), new Set(["Montserrat"]));
    expect(warnings).toEqual([]);
  });

  it("finds the pages that hold the touched layers", () => {
    const design = {
      pages: [
        { layers: [{ id: "a" }] },
        { layers: [{ id: "b" }] },
        { layers: [{ id: "c" }, { id: "d" }] },
      ],
    } as unknown as Design;
    expect(pagesOf(design, ["d", "a"])).toEqual([0, 2]);
  });
});
