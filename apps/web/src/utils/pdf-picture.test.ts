import { describe, expect, it } from "vitest";
import { type FrameLayer, type ImageLayer } from "@mycanvas/shared";
import { flipMatrix, framePath, framePlacement, fullPictureRect, imagePlacement, jpegExifOrientation, pictureMatrix, sniffPicture } from "./pdf-picture";
import { applyMatrix, multiplyMatrix, pathBounds } from "./pdf-vector";

const noShadow = { enabled: false, color: "#000000", blur: 0, offsetX: 0, offsetY: 0, opacity: 0 };
const base = { id: "a", name: "a", x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true };

function image(extra: Partial<ImageLayer> = {}): ImageLayer {
  return { ...base, type: "image", asset: "p.jpg", width: 200, height: 100, shadow: noShadow, ...extra };
}
function frame(extra: Partial<FrameLayer> = {}): FrameLayer {
  return { ...base, type: "frame", shape: "circle", width: 200, height: 100, content: { asset: "p.jpg", offsetX: -50, offsetY: -25, scale: 0.5 }, ...extra };
}

/** A JPEG skeleton: SOI, APP1 Exif (TIFF, one IFD entry), SOS. */
function jpegWithOrientation(orientation: number, little = true): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  const view = new DataView(tiff.buffer);
  tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 0x2a, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 1, little);
  view.setUint16(10, 0x0112, little);
  view.setUint16(12, 3, little);
  view.setUint32(14, 1, little);
  view.setUint16(18, orientation, little);
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = exif.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 255, ...exif, 0xff, 0xda, 0, 2]);
}

describe("imagePlacement", () => {
  it("fills the box with the whole picture when there is no crop", () => {
    const p = imagePlacement(image(), 800, 400);
    expect(p.target).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(p.source).toEqual({ x: 0, y: 0, width: 800, height: 400 });
    expect(fullPictureRect(p, 800, 400)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(pathBounds(p.clip)).toEqual([0, 0, 200, 100]);
    expect(applyMatrix(p.matrix, 0, 0)).toEqual({ x: 10, y: 20 });
  });

  it("maps the crop onto the box and places the whole picture around it", () => {
    const p = imagePlacement(image({ crop: { x: 100, y: 50, width: 400, height: 200 } }), 800, 400);
    // Crop is half the picture: the full picture is twice the box, shifted so the crop lands on it.
    expect(fullPictureRect(p, 800, 400)).toEqual({ x: -50, y: -25, width: 400, height: 200 });
  });

  it("mirrors about the box center", () => {
    const p = imagePlacement(image({ flipX: true }), 800, 400);
    const m = flipMatrix(p);
    expect(m).toEqual([-1, 0, 0, 1, 200, 0]);
    expect(applyMatrix(m ?? [1, 0, 0, 1, 0, 0], 30, 10)).toEqual({ x: 170, y: 10 });
    expect(flipMatrix(imagePlacement(image(), 800, 400))).toBeNull();
  });
});

describe("framePlacement", () => {
  it("places the whole picture at the content offset and scale inside the shape", () => {
    const p = framePlacement(frame(), 600, 300);
    expect(p?.target).toEqual({ x: -50, y: -25, width: 300, height: 150 });
    expect(p?.source).toEqual({ x: 0, y: 0, width: 600, height: 300 });
    expect(p && fullPictureRect(p, 600, 300)).toEqual(p?.target);
    expect(p && pathBounds(p.clip)).toEqual([0, 0, 200, 100]);
  });

  it("is null for an empty frame", () => {
    expect(framePlacement(frame({ content: undefined }), 600, 300)).toBeNull();
  });

  it("keeps the photo level in a turned frame through the content box", () => {
    expect(framePlacement(frame({ rotation: 30, contentRotation: 30 }), 600, 300)?.content).toBeUndefined();
    const p = framePlacement(frame({ rotation: 90, contentRotation: 0 }), 600, 300);
    // A quarter turn: the content box is 100 × 200, counter-turned by -90° about the frame center.
    expect([p?.width, p?.height]).toEqual([100, 200]);
    const m = p?.content ?? [1, 0, 0, 1, 0, 0];
    const center = applyMatrix(m, 50, 100);
    expect(center.x).toBeCloseTo(100);
    expect(center.y).toBeCloseTo(50);
    // Combined with the frame's own 90° turn the photo's x axis stays level on the page.
    const page = multiplyMatrix(p?.matrix ?? [1, 0, 0, 1, 0, 0], m);
    expect(page[0]).toBeCloseTo(1);
    expect(page[1]).toBeCloseTo(0);
  });
});

describe("framePath", () => {
  it("spans the box for every frame shape", () => {
    for (const shape of ["rect", "circle", "triangle", "hexagon", "star", "semicircle"] as const) {
      const [x0, y0, x1, y1] = pathBounds(framePath(shape, 120, 80, 0));
      expect([x0, y0, x1, y1].map((v) => Math.round(v * 1000) / 1000), shape).toEqual([0, 0, 120, 80]);
    }
  });

  it("rounds rect corners with quadratic-derived cubics, like traceFramePath", () => {
    const path = framePath("rect", 100, 50, 10);
    // roundedPolygonPath starts a corner's radius before vertex 0: (0, 10).
    expect(path[0]).toEqual({ op: "M", x: 0, y: 10 });
    expect(path.filter((c) => c.op === "C")).toHaveLength(4);
  });
});

describe("pictureMatrix", () => {
  it("maps the unit square onto the rect with the top edge at rect.y", () => {
    const m = pictureMatrix({ x: 5, y: 7, width: 20, height: 10 });
    expect(applyMatrix(m, 0, 1)).toEqual({ x: 5, y: 7 }); // image top-left
    expect(applyMatrix(m, 1, 0)).toEqual({ x: 25, y: 17 }); // image bottom-right
  });
});

describe("picture files", () => {
  it("sniffs JPEG and PNG, nothing else", () => {
    expect(sniffPicture(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffPicture(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(sniffPicture(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBeNull();
  });

  it("reads the EXIF orientation in either byte order", () => {
    expect(jpegExifOrientation(jpegWithOrientation(6))).toBe(6);
    expect(jpegExifOrientation(jpegWithOrientation(3, false))).toBe(3);
    expect(jpegExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(jpegExifOrientation(new Uint8Array([0x89, 0x50]))).toBe(1);
  });
});
