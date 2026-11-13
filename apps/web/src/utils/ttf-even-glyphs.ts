/**
 * Pads every glyph of a TrueType font to an even byte length.
 *
 * Why: fontkit's subsetter (used by pdf-lib for embedded fonts) copies each
 * glyph's bytes verbatim and then writes the subset's `loca` table in the
 * short format (offset ÷ 2) whenever the glyph data is small enough. A font
 * whose own `loca` is long may have odd-length glyphs; their halved offsets
 * truncate, every glyph after one drifts by a byte, and PDF viewers draw
 * garbage or nothing for it (Inter Bold lost "V", "t", "o", "P", "D", "F").
 * With even glyph lengths the short offsets are exact.
 *
 * Pure: takes the font file bytes, returns new bytes (or the same array
 * when nothing needs padding or the file isn't a TrueType-outline font).
 */

interface TableRecord {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

function readTables(view: DataView): TableRecord[] | null {
  if (view.byteLength < 12) {
    return null;
  }
  const sfnt = view.getUint32(0);
  // 0x00010000 and "true" are TrueType outlines; "OTTO" (CFF) has no glyf.
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565) {
    return null;
  }
  const count = view.getUint16(4);
  if (view.byteLength < 12 + count * 16) {
    return null;
  }
  const tables: TableRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    tables.push({ tag, checksum: view.getUint32(at + 4), offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return tables;
}

function tableChecksum(bytes: Uint8Array): number {
  let sum = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = bytes.length - (bytes.length % 4);
  for (let i = 0; i < whole; i += 4) {
    sum = (sum + view.getUint32(i)) >>> 0;
  }
  if (whole < bytes.length) {
    let tail = 0;
    for (let i = 0; i < 4; i += 1) {
      tail = (tail << 8) | (whole + i < bytes.length ? (bytes[whole + i] ?? 0) : 0);
    }
    sum = (sum + (tail >>> 0)) >>> 0;
  }
  return sum;
}

/** Glyph byte ranges from `loca` (short or long). */
export function readLoca(loca: Uint8Array, numGlyphs: number, longFormat: boolean): number[] | null {
  const view = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
  const size = longFormat ? 4 : 2;
  if (loca.byteLength < (numGlyphs + 1) * size) {
    return null;
  }
  const offsets: number[] = [];
  for (let i = 0; i <= numGlyphs; i += 1) {
    offsets.push(longFormat ? view.getUint32(i * 4) : view.getUint16(i * 2) * 2);
  }
  return offsets;
}

export function padTrueTypeGlyphs(font: Uint8Array): Uint8Array {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = readTables(view);
  if (!tables) {
    return font;
  }
  const byTag = new Map(tables.map((table) => [table.tag, table]));
  const head = byTag.get("head");
  const maxp = byTag.get("maxp");
  const loca = byTag.get("loca");
  const glyf = byTag.get("glyf");
  if (!head || !maxp || !loca || !glyf || head.length < 54 || maxp.length < 6) {
    return font;
  }
  const slice = (table: TableRecord) => font.subarray(table.offset, table.offset + table.length);
  if ([head, maxp, loca, glyf].some((table) => table.offset + table.length > font.byteLength)) {
    return font;
  }
  const numGlyphs = view.getUint16(maxp.offset + 4);
  const longFormat = view.getInt16(head.offset + 50) === 1;
  const offsets = readLoca(slice(loca), numGlyphs, longFormat);
  if (!offsets) {
    return font;
  }
  let padded = 0;
  for (let i = 0; i < numGlyphs; i += 1) {
    const length = (offsets[i + 1] ?? 0) - (offsets[i] ?? 0);
    if (length < 0 || (offsets[i + 1] ?? 0) > glyf.length) {
      return font;
    }
    if (length % 2 === 1) {
      padded += 1;
    }
  }
  if (padded === 0) {
    return font;
  }

  // New glyf (each glyph padded to even) and a long loca to match.
  const oldGlyf = slice(glyf);
  const newGlyf = new Uint8Array(glyf.length + padded);
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const locaView = new DataView(newLoca.buffer);
  let at = 0;
  for (let i = 0; i < numGlyphs; i += 1) {
    const start = offsets[i] ?? 0;
    const end = offsets[i + 1] ?? 0;
    locaView.setUint32(i * 4, at);
    newGlyf.set(oldGlyf.subarray(start, end), at);
    at += end - start;
    if ((end - start) % 2 === 1) {
      at += 1; // the pad byte is already zero
    }
  }
  locaView.setUint32(numGlyphs * 4, at);
  const newHead = new Uint8Array(slice(head));
  new DataView(newHead.buffer).setInt16(50, 1);
  new DataView(newHead.buffer).setUint32(8, 0); // checkSumAdjustment, set below

  // Rebuild the file: same table order, tables 4-byte aligned.
  const replaced = new Map<string, Uint8Array>([
    ["glyf", newGlyf],
    ["loca", newLoca],
    ["head", newHead],
  ]);
  const contents = tables.map((table) => replaced.get(table.tag) ?? slice(table));
  const headerSize = 12 + tables.length * 16;
  let total = headerSize;
  const placed = contents.map((bytes) => {
    const offset = total;
    total += (bytes.length + 3) & ~3;
    return offset;
  });
  const out = new Uint8Array(total);
  out.set(font.subarray(0, 12));
  const outView = new DataView(out.buffer);
  tables.forEach((_table, index) => {
    const bytes = contents[index] ?? new Uint8Array(0);
    const offset = placed[index] ?? headerSize;
    const at = 12 + index * 16;
    out.set(font.subarray(12 + index * 16, 12 + index * 16 + 4), at);
    outView.setUint32(at + 4, tableChecksum(bytes));
    outView.setUint32(at + 8, offset);
    outView.setUint32(at + 12, bytes.length);
    out.set(bytes, offset);
  });
  const headIndex = tables.indexOf(head);
  const headOffset = placed[headIndex] ?? headerSize;
  outView.setUint32(headOffset + 8, (0xb1b0afba - tableChecksum(out)) >>> 0);
  return out;
}
