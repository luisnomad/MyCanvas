/**
 * Pixel size of an uploaded image, read from its header (PNG, JPEG, GIF,
 * WebP, SVG). Returns null when the format is unknown or the file is broken.
 */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  try {
    return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes) ?? svg(bytes);
  } catch {
    return null;
  }
}

function valid(width: number, height: number): { width: number; height: number } | null {
  return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function png(b: Buffer) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  return valid(b.readUInt32BE(16), b.readUInt32BE(20));
}

function jpeg(b: Buffer) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = b[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = b.readUInt16BE(offset + 2);
    // Start-of-frame markers (not DHT 0xc4, JPG 0xc8, DAC 0xcc) hold the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return valid(b.readUInt16BE(offset + 7), b.readUInt16BE(offset + 5));
    }
    offset += 2 + length;
  }
  return null;
}

function gif(b: Buffer) {
  if (b.length < 10 || b.toString("ascii", 0, 3) !== "GIF") {
    return null;
  }
  return valid(b.readUInt16LE(6), b.readUInt16LE(8));
}

function webp(b: Buffer) {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return valid(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
  }
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return valid(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
  }
  if (chunk === "VP8 ") {
    return valid(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  return null;
}

function svg(b: Buffer) {
  const text = b.toString("utf8", 0, Math.min(b.length, 4096));
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) {
    return null;
  }
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)(px)?\\s*["']`, "i").exec(tag)?.[1];
  const width = attr("width");
  const height = attr("height");
  if (width !== undefined && height !== undefined) {
    return valid(Number(width), Number(height));
  }
  const viewBox = /\sviewBox\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4) {
    return valid(viewBox[2] ?? 0, viewBox[3] ?? 0);
  }
  return null;
}
