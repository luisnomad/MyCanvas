/*
 * Pixel measurements for the AI review. The model says roughly what and
 * where; these find the exact colours and edges in the example page, and
 * score how close a page looks to it.
 */

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Rgb = [number, number, number];

export function colorAt(pixels: Pixels, x: number, y: number): Rgb {
  const px = Math.max(0, Math.min(pixels.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(pixels.height - 1, Math.round(y)));
  const index = (py * pixels.width + px) * 4;
  return [pixels.data[index] ?? 0, pixels.data[index + 1] ?? 0, pixels.data[index + 2] ?? 0];
}

/** Largest channel difference, 0–255. */
export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

export function toHex(color: Rgb): string {
  return `#${color.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

export function fromHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) {
    return null;
  }
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Most common colour among the given points (colours grouped to 8 levels per channel step). */
function dominant(pixels: Pixels, points: Iterable<[number, number]>): Rgb {
  const counts = new Map<number, { count: number; sum: Rgb }>();
  for (const [x, y] of points) {
    const color = colorAt(pixels, x, y);
    const key = ((color[0] >> 3) << 10) | ((color[1] >> 3) << 5) | (color[2] >> 3);
    const entry = counts.get(key) ?? { count: 0, sum: [0, 0, 0] };
    entry.count++;
    entry.sum[0] += color[0];
    entry.sum[1] += color[1];
    entry.sum[2] += color[2];
    counts.set(key, entry);
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return best ? [best.sum[0] / best.count, best.sum[1] / best.count, best.sum[2] / best.count] : [255, 255, 255];
}

function* ring(rect: Rect, pixels: Pixels): Generator<[number, number]> {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(pixels.width - 1, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(pixels.height - 1, Math.ceil(rect.y + rect.height));
  for (let x = x0; x <= x1; x++) {
    yield [x, y0];
    yield [x, y1];
  }
  for (let y = y0; y <= y1; y++) {
    yield [x0, y];
    yield [x1, y];
  }
}

/** The page colour: most common colour along the image's edges. */
export function pageColor(pixels: Pixels): Rgb {
  return dominant(pixels, ring({ x: 0, y: 0, width: pixels.width - 1, height: pixels.height - 1 }, pixels));
}

/** Most common colour just outside a rectangle. */
export function colorAround(pixels: Pixels, rect: Rect, pad: number): Rgb {
  return dominant(pixels, ring({ x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }, pixels));
}

/** Most common colour in a small square around a point. */
export function colorNear(pixels: Pixels, x: number, y: number, radius = 3): Rgb {
  const points: [number, number][] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      points.push([x + dx, y + dy]);
    }
  }
  return dominant(pixels, points);
}

/**
 * Grows a rectangle outward while the next row or column is (almost) all of
 * one colour: finds the edges of a coloured box from a seed inside it.
 */
export function growBox(pixels: Pixels, seed: Rect, color: Rgb, tolerance: number): Rect {
  let x0 = Math.max(0, Math.floor(seed.x));
  let y0 = Math.max(0, Math.floor(seed.y));
  let x1 = Math.min(pixels.width - 1, Math.ceil(seed.x + seed.width));
  let y1 = Math.min(pixels.height - 1, Math.ceil(seed.y + seed.height));
  const filled = (points: [number, number][]) =>
    points.filter(([x, y]) => colorDistance(colorAt(pixels, x, y), color) <= tolerance).length >= points.length * 0.85;
  const row = (y: number) => Array.from({ length: x1 - x0 + 1 }, (_, i): [number, number] => [x0 + i, y]);
  const column = (x: number) => Array.from({ length: y1 - y0 + 1 }, (_, i): [number, number] => [x, y0 + i]);
  for (let grew = true; grew;) {
    grew = false;
    if (y0 > 0 && filled(row(y0 - 1))) {
      y0--;
      grew = true;
    }
    if (y1 < pixels.height - 1 && filled(row(y1 + 1))) {
      y1++;
      grew = true;
    }
    if (x0 > 0 && filled(column(x0 - 1))) {
      x0--;
      grew = true;
    }
    if (x1 < pixels.width - 1 && filled(column(x1 + 1))) {
      x1++;
      grew = true;
    }
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Colours of the marks (text, lines) inside a rectangle, most used first. */
export function inkColors(pixels: Pixels, rect: Rect, background: Rgb, minDistance = 60): Rgb[] {
  const counts = new Map<number, { count: number; sum: Rgb }>();
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(pixels.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(pixels.height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const color = colorAt(pixels, x, y);
      if (colorDistance(color, background) < minDistance) {
        continue;
      }
      const key = ((color[0] >> 4) << 8) | ((color[1] >> 4) << 4) | (color[2] >> 4);
      const entry = counts.get(key) ?? { count: 0, sum: [0, 0, 0] };
      entry.count++;
      entry.sum[0] += color[0];
      entry.sum[1] += color[1];
      entry.sum[2] += color[2];
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.count >= 4)
    .sort((a, b) => b.count - a.count)
    .map((entry): Rgb => [entry.sum[0] / entry.count, entry.sum[1] / entry.count, entry.sum[2] / entry.count]);
}

/**
 * How different two same-size images look, 0 (identical) to 1. Optionally
 * only inside a rectangle (in the images' pixels).
 */
export function difference(a: Pixels, b: Pixels, within?: Rect): number {
  const x0 = within ? Math.max(0, Math.floor(within.x)) : 0;
  const y0 = within ? Math.max(0, Math.floor(within.y)) : 0;
  const x1 = within ? Math.min(a.width, Math.ceil(within.x + within.width)) : a.width;
  const y1 = within ? Math.min(a.height, Math.ceil(within.y + within.height)) : a.height;
  let total = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const index = (y * a.width + x) * 4;
      total += Math.abs((a.data[index] ?? 0) - (b.data[index] ?? 0)) +
        Math.abs((a.data[index + 1] ?? 0) - (b.data[index + 1] ?? 0)) +
        Math.abs((a.data[index + 2] ?? 0) - (b.data[index + 2] ?? 0));
      count++;
    }
  }
  return count ? total / (count * 765) : 0;
}

/** Pixels that differ from a base image (marks added on top of it). */
export function inkMask(image: Pixels, base: Pixels, threshold = 48): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i++) {
    const index = i * 4;
    const distance = Math.max(
      Math.abs((image.data[index] ?? 0) - (base.data[index] ?? 0)),
      Math.abs((image.data[index + 1] ?? 0) - (base.data[index + 1] ?? 0)),
      Math.abs((image.data[index + 2] ?? 0) - (base.data[index + 2] ?? 0)),
    );
    mask[i] = distance > threshold ? 1 : 0;
  }
  return mask;
}

/**
 * How well two masks overlap (Dice), 0 to 1. Unlike a plain difference it
 * can't be improved by hiding or shrinking marks: only by lining them up.
 */
export function overlap(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    both += (a[i] ?? 0) & (b[i] ?? 0);
    sum += (a[i] ?? 0) + (b[i] ?? 0);
  }
  return sum ? (2 * both) / sum : 0;
}

/** Colour difference, 0 to 1, where both images have marks; 1 when they share none. */
export function inkColorDifference(a: Pixels, b: Pixels, maskA: Uint8Array, maskB: Uint8Array): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < maskA.length; i++) {
    if (!maskA[i] || !maskB[i]) {
      continue;
    }
    const index = i * 4;
    total += Math.abs((a.data[index] ?? 0) - (b.data[index] ?? 0)) +
      Math.abs((a.data[index + 1] ?? 0) - (b.data[index + 1] ?? 0)) +
      Math.abs((a.data[index + 2] ?? 0) - (b.data[index + 2] ?? 0));
    count++;
  }
  return count ? total / (count * 765) : 1;
}

/** A mask grown by r pixels in every direction (square). */
export function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r < 1) {
    return mask.slice();
  }
  const across = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    let last = -Infinity;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        last = x;
      }
      if (x - last <= r) {
        across[y * width + x] = 1;
      }
    }
    last = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[y * width + x]) {
        last = x;
      }
      if (last - x <= r) {
        across[y * width + x] = 1;
      }
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    for (let y = 0; y < height; y++) {
      if (across[y * width + x]) {
        last = y;
      }
      if (y - last <= r) {
        out[y * width + x] = 1;
      }
    }
    last = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (across[y * width + x]) {
        last = y;
      }
      if (last - y <= r) {
        out[y * width + x] = 1;
      }
    }
  }
  return out;
}

/** Connected regions of a mask (4-neighbour); 0 = none, 1… = region number. */
export function regions(mask: Uint8Array, width: number, height: number): Int32Array {
  const labels = new Int32Array(mask.length);
  let next = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) {
      continue;
    }
    next++;
    labels[start] = next;
    stack.push(start);
    while (stack.length) {
      const index = stack.pop() ?? 0;
      const x = index % width;
      const y = (index - x) / width;
      const neighbours = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1];
      for (const n of neighbours) {
        if (n >= 0 && mask[n] && !labels[n]) {
          labels[n] = next;
          stack.push(n);
        }
      }
    }
  }
  return labels;
}

/**
 * The part of the example's ink that belongs to the same block of text as
 * ours: example ink grown into blocks (lines of a paragraph merge, separate
 * paragraphs don't), keeping the block our ink overlaps most. Without this,
 * text that grows onto a neighbouring paragraph would seem to "fit" better.
 */
export function sameBlockInk(exampleInk: Uint8Array, ownInk: Uint8Array, width: number, height: number, gap: number): Uint8Array {
  const labels = regions(dilate(exampleInk, width, height, gap), width, height);
  const hits = new Map<number, number>();
  for (let i = 0; i < exampleInk.length; i++) {
    if (exampleInk[i] && ownInk[i]) {
      const label = labels[i] ?? 0;
      hits.set(label, (hits.get(label) ?? 0) + 1);
    }
  }
  const best = [...hits].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best === undefined) {
    return exampleInk;
  }
  return exampleInk.map((value, i) => (value && labels[i] === best ? 1 : 0));
}
