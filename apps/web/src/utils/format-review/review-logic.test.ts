import { describe, expect, it } from "vitest";
import { type DesignPage, type Layer, type TextLayer, defaultShadow, defaultStroke } from "@mycanvas/shared";
import { type TableRow, applyChanges, parseEdits } from "./edits";
import { type Pixels, type Rgb, colorAround, difference, growBox, inkColors, overlap, pageColor, sameBlockInk } from "./measure";

function image(width: number, height: number, fill: Rgb): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data.set([...fill, 255], index);
  }
  return { data, width, height };
}

function paint(pixels: Pixels, x0: number, y0: number, x1: number, y1: number, color: Rgb) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      pixels.data.set([...color, 255], (y * pixels.width + x) * 4);
    }
  }
}

function text(id: string, extra: Partial<TextLayer> = {}): TextLayer {
  return {
    id, name: `${id} sample`, x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true,
    type: "text", text: "Hello", fontFamily: "Inter", fontSize: 20, fontStyle: "normal", fill: "#111111",
    align: "left", lineHeight: 1.2, letterSpacing: 0, wrapWidth: 200, effect: { type: "none" },
    shadow: defaultShadow(), stroke: defaultStroke(), ...extra,
  };
}

const rows = (layers: Layer[]): TableRow[] => layers.map((layer, index) => ({ short: `L${String(index + 1)}`, layer, box: { x: 0, y: 0, width: 10, height: 10 } }));

describe("measure", () => {
  it("finds a light strip barely different from the page, without bleeding into it", () => {
    const page = image(200, 120, [255, 255, 255]);
    paint(page, 20, 40, 180, 80, [238, 237, 236]);
    paint(page, 30, 52, 90, 66, [20, 20, 20]); // text on the strip
    const inside = colorAround(page, { x: 30, y: 52, width: 60, height: 14 }, 4);
    expect(inside).toEqual([238, 237, 236]);
    const box = growBox(page, { x: 28, y: 50, width: 64, height: 18 }, inside, 8);
    expect(box).toEqual({ x: 20, y: 40, width: 160, height: 40 });
    expect(pageColor(page)).toEqual([255, 255, 255]);
  });

  it("reads the ink colour of text over a background", () => {
    const page = image(100, 40, [255, 255, 255]);
    paint(page, 10, 10, 60, 20, [14, 159, 219]);
    expect(inkColors(page, { x: 0, y: 0, width: 100, height: 40 }, [255, 255, 255])[0]).toEqual([14, 159, 219]);
  });

  it("scores difference from 0 to 1, optionally in an area", () => {
    const white = image(10, 10, [255, 255, 255]);
    const black = image(10, 10, [0, 0, 0]);
    expect(difference(white, black)).toBe(1);
    const half = image(10, 10, [255, 255, 255]);
    paint(half, 0, 0, 5, 10, [0, 0, 0]);
    expect(difference(white, half)).toBeCloseTo(0.5);
    expect(difference(white, half, { x: 5, y: 0, width: 5, height: 10 })).toBe(0);
  });
});

describe("parseEdits", () => {
  const layers: Layer[] = [
    text("art", { locked: true }),
    text("heading", { formatRole: { kind: "sample", block: "heading", spaceBefore: 10 } }),
    text("footer"),
  ];

  it("keeps valid edits and drops ones aimed at the wrong layer", () => {
    const answer = "Here you go:\n```json\n" + JSON.stringify({
      edits: [
        { op: "style", layer: "L2", color: "#0E9FDB", weight: 880, why: "Cyan in the example" },
        { op: "move", layer: "L1", x: 10, y: 10, why: "locked" },
        { op: "role", layer: "L3", block: "title", why: "not a sample" },
        { op: "box", layer: 2, why: "on a strip" },
        { op: "remove", layer: "l3", why: "page counter" },
        { op: "callout", x: 500, y: 2000, text: "x", why: "off the grid" },
        { op: "flow", bottom: 900, why: "no flow layer" },
        { op: "paint", layer: "L2" },
      ],
    }) + "\n```";
    const { edits, rejected } = parseEdits(answer, rows(layers));
    expect(edits).toEqual([
      { op: "style", layer: "L2", color: "#0e9fdb", weight: 900, why: "Cyan in the example" },
      { op: "box", layer: "L2", why: "on a strip" },
      { op: "remove", layer: "L3", why: "page counter" },
    ]);
    expect(rejected).toBe(5);
  });

  it("survives answers that aren't JSON", () => {
    expect(parseEdits("Looks good to me!", rows(layers))).toEqual({ edits: [], rejected: 0 });
  });
});

describe("applyChanges", () => {
  it("patches, removes and inserts before the reference layer", () => {
    const reference = text("ref", { formatRole: { kind: "reference" } });
    const pages: DesignPage[] = [
      { id: "p1", background: "#ffffff", layers: [text("a"), text("b"), reference] },
      { id: "p2", background: "#ffffff", layers: [text("c")] },
    ];
    const result = applyChanges(pages, "p1", [
      { patches: [{ id: "a", patch: { fill: "#ff0000" } }], add: [], remove: ["b"] },
      { patches: [{ id: "a", patch: { fontSize: 30 } }], add: [{ layers: [text("new")], before: null }], remove: [] },
    ]);
    expect(result[0]?.layers.map((layer) => layer.id)).toEqual(["a", "new", "ref"]);
    expect(result[0]?.layers[0]).toMatchObject({ fill: "#ff0000", fontSize: 30 });
    expect(result[1]).toBe(pages[1]);
  });
});

describe("overlap scoring", () => {
  const W = 40;
  const H = 30;
  const mask = (cells: [number, number, number, number][]) => {
    const out = new Uint8Array(W * H);
    for (const [x0, y0, x1, y1] of cells) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          out[y * W + x] = 1;
        }
      }
    }
    return out;
  };

  it("rewards lining up, not shrinking", () => {
    const example = mask([[5, 5, 25, 9]]);
    expect(overlap(mask([[5, 5, 25, 9]]), example)).toBe(1);
    expect(overlap(mask([[5, 5, 10, 6]]), example)).toBeLessThan(0.2);
    expect(overlap(new Uint8Array(W * H), example)).toBe(0);
  });

  it("keeps only the block of example text ours sits on", () => {
    // Two lines of one paragraph (gap 2) and a separate paragraph further down (gap 8).
    const example = mask([[5, 5, 30, 8], [5, 10, 30, 13], [5, 21, 30, 24]]);
    const ours = mask([[5, 5, 30, 8]]);
    const block = sameBlockInk(example, ours, W, H, 2);
    expect(block.reduce((sum, value) => sum + value, 0)).toBe(25 * 3 * 2);
    // A text grown over both paragraphs no longer scores better than one that fits the first.
    const grown = mask([[5, 5, 30, 24]]);
    expect(overlap(grown, block)).toBeLessThan(overlap(mask([[5, 5, 30, 13]]), block));
  });
});
