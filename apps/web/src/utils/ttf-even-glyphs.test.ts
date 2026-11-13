import { describe, expect, it } from "vitest";
import { padTrueTypeGlyphs, readLoca } from "./ttf-even-glyphs";

/** A minimal TrueType file: head, maxp, loca and glyf with the given glyph bytes. */
function makeFont(glyphs: Uint8Array[], longLoca: boolean, sfnt = 0x00010000): Uint8Array {
  const head = new Uint8Array(54);
  new DataView(head.buffer).setInt16(50, longLoca ? 1 : 0);
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint16(4, glyphs.length);
  const glyf = new Uint8Array(glyphs.reduce((n, g) => n + g.length, 0));
  const loca = new Uint8Array((glyphs.length + 1) * (longLoca ? 4 : 2));
  const locaView = new DataView(loca.buffer);
  let at = 0;
  glyphs.forEach((glyph, index) => {
    if (longLoca) {
      locaView.setUint32(index * 4, at);
    } else {
      locaView.setUint16(index * 2, at / 2);
    }
    glyf.set(glyph, at);
    at += glyph.length;
  });
  if (longLoca) {
    locaView.setUint32(glyphs.length * 4, at);
  } else {
    locaView.setUint16(glyphs.length * 2, at / 2);
  }
  const tables: [string, Uint8Array][] = [["glyf", glyf], ["head", head], ["loca", loca], ["maxp", maxp]];
  let total = 12 + tables.length * 16;
  const offsets = tables.map(([, bytes]) => {
    const offset = total;
    total += (bytes.length + 3) & ~3;
    return offset;
  });
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, sfnt);
  view.setUint16(4, tables.length);
  tables.forEach(([tag, bytes], index) => {
    const at = 12 + index * 16;
    [...tag].forEach((ch, i) => { out[at + i] = ch.charCodeAt(0); });
    view.setUint32(at + 8, offsets[index] ?? 0);
    view.setUint32(at + 12, bytes.length);
    out.set(bytes, offsets[index] ?? 0);
  });
  return out;
}

function tables(font: Uint8Array) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const count = view.getUint16(4);
  const map = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...font.subarray(at, at + 4));
    map.set(tag, font.subarray(view.getUint32(at + 8), view.getUint32(at + 8) + view.getUint32(at + 12)));
  }
  return map;
}

function glyphsOf(font: Uint8Array): Uint8Array[] {
  const t = tables(font);
  const head = t.get("head") ?? new Uint8Array(54);
  const numGlyphs = new DataView((t.get("maxp") ?? new Uint8Array(6)).buffer, t.get("maxp")?.byteOffset).getUint16(4);
  const longFormat = new DataView(head.buffer, head.byteOffset).getInt16(50) === 1;
  const offsets = readLoca(t.get("loca") ?? new Uint8Array(0), numGlyphs, longFormat) ?? [];
  const glyf = t.get("glyf") ?? new Uint8Array(0);
  return offsets.slice(0, -1).map((start, i) => glyf.subarray(start, offsets[i + 1]));
}

describe("padTrueTypeGlyphs", () => {
  const odd = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7]), new Uint8Array([8, 9, 10, 11, 12]), new Uint8Array(0), new Uint8Array([13])];

  it("pads odd glyphs with a zero byte and keeps every glyph's bytes", () => {
    const out = padTrueTypeGlyphs(makeFont(odd, true));
    const glyphs = glyphsOf(out);
    expect(glyphs.map((g) => g.length)).toEqual([4, 4, 6, 0, 2]);
    expect([...(glyphs[0] ?? [])]).toEqual([1, 2, 3, 0]);
    expect([...(glyphs[2] ?? [])]).toEqual([8, 9, 10, 11, 12, 0]);
    expect([...(glyphs[4] ?? [])]).toEqual([13, 0]);
    // A long loca after padding, with even offsets a short loca can store exactly.
    const head = tables(out).get("head") ?? new Uint8Array(54);
    expect(new DataView(head.buffer, head.byteOffset).getInt16(50)).toBe(1);
    expect(tables(out).get("loca")?.length).toBe(6 * 4);
  });

  it("leaves a font with even glyphs untouched", () => {
    const even = makeFont([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])], false);
    expect(padTrueTypeGlyphs(even)).toBe(even);
  });

  it("ignores CFF fonts and junk", () => {
    const cff = makeFont(odd, true, 0x4f54544f);
    expect(padTrueTypeGlyphs(cff)).toBe(cff);
    const junk = new Uint8Array([1, 2, 3]);
    expect(padTrueTypeGlyphs(junk)).toBe(junk);
  });

  it("keeps the table directory consistent and 4-byte aligned", () => {
    const out = padTrueTypeGlyphs(makeFont(odd, true));
    const view = new DataView(out.buffer);
    for (let i = 0; i < view.getUint16(4); i += 1) {
      const at = 12 + i * 16;
      expect(view.getUint32(at + 8) % 4).toBe(0);
      expect(view.getUint32(at + 8) + view.getUint32(at + 12)).toBeLessThanOrEqual(out.length);
    }
    // The whole-file checksum rule: sum of all 32-bit words is 0xB1B0AFBA.
    let sum = 0;
    for (let i = 0; i + 4 <= out.length; i += 4) {
      sum = (sum + view.getUint32(i)) >>> 0;
    }
    expect(sum).toBe(0xb1b0afba);
  });
});
