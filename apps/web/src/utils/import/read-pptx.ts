import JSZip from "jszip";
import { type RawParagraph } from "./classify";
import { type ImageUploader } from "./types";

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Resolves a relationship target ("../media/image1.png") against a part's folder. */
function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") {
      parts.pop();
    } else if (segment !== ".") {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

async function readRels(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const folder = partPath.split("/").slice(0, -1).join("/");
  const name = partPath.split("/").pop() ?? "";
  const xml = await zip.file(`${folder}/_rels/${name}.rels`)?.async("string");
  const rels = new Map<string, string>();
  if (!xml) {
    return rels;
  }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  for (const rel of doc.getElementsByTagName("Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target && rel.getAttribute("TargetMode") !== "External") {
      rels.set(id, resolvePath(partPath, target));
    }
  }
  return rels;
}

/** Child elements by qualified name ("a:p"), direct children only. */
function children(element: Element, name: string): Element[] {
  return [...element.children].filter((child) => child.tagName === name);
}

function descendants(element: Element, name: string): Element[] {
  return [...element.getElementsByTagName(name)];
}

interface Shape {
  y: number;
  x: number;
  paragraphs: RawParagraph[];
}

/** Position of a shape (EMU), for reading order; groups use their own offset. */
function positionOf(element: Element): { x: number; y: number } {
  const off = descendants(element, "a:off")[0];
  return { x: Number(off?.getAttribute("x") ?? 0), y: Number(off?.getAttribute("y") ?? 0) };
}

/** Paragraphs of a text body, with size (pt), bold and bullet info. */
function readTextBody(body: Element, placeholder: string | null): RawParagraph[] {
  const out: RawParagraph[] = [];
  for (const paragraph of children(body, "a:p")) {
    const runs = [...children(paragraph, "a:r"), ...children(paragraph, "a:fld")];
    let text = "";
    for (const node of paragraph.children) {
      if (node.tagName === "a:r" || node.tagName === "a:fld") {
        text += descendants(node, "a:t").map((t) => t.textContent ?? "").join("");
      } else if (node.tagName === "a:br") {
        text += " ";
      }
    }
    if (!text.trim()) {
      continue;
    }
    const sizes = runs
      .map((run) => run.getElementsByTagName("a:rPr")[0]?.getAttribute("sz"))
      .filter((size): size is string => Boolean(size))
      .map(Number);
    const textRuns = runs.filter((run) => (run.textContent ?? "").trim());
    const bold = textRuns.length > 0 && textRuns.every((run) => run.getElementsByTagName("a:rPr")[0]?.getAttribute("b") === "1");
    const pPr = children(paragraph, "a:pPr")[0];
    const bulleted = Boolean(pPr && (children(pPr, "a:buChar").length > 0 || children(pPr, "a:buAutoNum").length > 0));
    const raw: RawParagraph = {
      text,
      bold,
      size: sizes.length > 0 ? Math.max(...sizes) / 100 : undefined,
    };
    if (placeholder === "title" || placeholder === "ctrTitle") {
      raw.role = placeholder === "ctrTitle" ? "title" : "heading";
    } else if (placeholder === "subTitle") {
      raw.role = "subtitle";
    } else if (bulleted) {
      raw.role = "listItem";
    }
    out.push(raw);
  }
  return out;
}

/** Slide page numbers and similar furniture ("01 / 10", "7"). */
function isSlideFurniture(text: string): boolean {
  return /^\s*\d{1,3}\s*(?:\/\s*\d{1,3})?\s*$/.test(text);
}

async function readShapes(
  container: Element,
  rels: Map<string, string>,
  zip: JSZip,
  upload: ImageUploader,
  warnings: string[],
  label: string,
): Promise<Shape[]> {
  const shapes: Shape[] = [];
  for (const element of container.children) {
    const { x, y } = positionOf(element);
    if (element.tagName === "p:sp") {
      const placeholder = descendants(element, "p:ph")[0]?.getAttribute("type") ?? null;
      if (placeholder === "sldNum" || placeholder === "dt" || placeholder === "ftr") {
        continue;
      }
      const body = children(element, "p:txBody")[0];
      if (body) {
        const paragraphs = readTextBody(body, placeholder).filter((paragraph) => !isSlideFurniture(paragraph.text));
        if (paragraphs.length > 0) {
          shapes.push({ x, y, paragraphs });
        }
      }
    } else if (element.tagName === "p:pic") {
      const embed = descendants(element, "a:blip")[0]?.getAttributeNS(REL_NS, "embed");
      const path = embed ? rels.get(embed) : undefined;
      const file = path ? zip.file(path) : null;
      if (path && file) {
        const extension = path.split(".").pop()?.toLowerCase() ?? "png";
        if (!["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) {
          warnings.push(`${label}: skipped an image in ${extension.toUpperCase()} format.`);
          continue;
        }
        const name = descendants(element, "p:cNvPr")[0]?.getAttribute("descr") ?? "";
        try {
          const type = extension === "svg" ? "image/svg+xml" : `image/${extension === "jpg" ? "jpeg" : extension}`;
          const asset = await upload(new Blob([await file.async("arraybuffer")], { type }), `${label} ${path.split("/").pop() ?? "image"}`);
          shapes.push({ x, y, paragraphs: [{ role: "image", text: name, asset }] });
        } catch {
          warnings.push(`${label}: an image couldn't be uploaded.`);
        }
      }
    } else if (element.tagName === "p:grpSp") {
      shapes.push(...await readShapes(element, rels, zip, upload, warnings, label));
    } else if (element.tagName === "p:graphicFrame") {
      const rows = descendants(element, "a:tr").map((row) =>
        descendants(row, "a:tc").map((cell) => descendants(cell, "a:t").map((t) => t.textContent ?? "").join(" ").trim()).filter(Boolean).join(" · "));
      const paragraphs = rows.filter(Boolean).map((text) => ({ text }));
      if (paragraphs.length > 0) {
        shapes.push({ x, y, paragraphs });
      }
    }
  }
  return shapes;
}

export async function readPptx(
  file: File,
  upload: ImageUploader,
  pagePerSlide: boolean,
): Promise<{ paragraphs: RawParagraph[]; warnings: string[]; slides: number }> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const warnings: string[] = [];
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  if (!presentationXml) {
    throw new Error("This doesn't look like a PowerPoint file.");
  }
  const presentationRels = await readRels(zip, "ppt/presentation.xml");
  const presentation = new DOMParser().parseFromString(presentationXml, "application/xml");
  const slidePaths = [...presentation.getElementsByTagName("p:sldId")]
    .map((slide) => presentationRels.get(slide.getAttributeNS(REL_NS, "id") ?? ""))
    .filter((path): path is string => Boolean(path));

  const paragraphs: RawParagraph[] = [];
  for (const [index, slidePath] of slidePaths.entries()) {
    const xml = await zip.file(slidePath)?.async("string");
    if (!xml) {
      continue;
    }
    const slide = new DOMParser().parseFromString(xml, "application/xml");
    if (slide.documentElement.getAttribute("show") === "0") {
      continue;
    }
    const tree = slide.getElementsByTagName("p:spTree")[0];
    if (!tree) {
      continue;
    }
    const rels = await readRels(zip, slidePath);
    const shapes = await readShapes(tree, rels, zip, upload, warnings, `Slide ${String(index + 1)}`);
    // Reading order: top to bottom, then left to right (rows within ~0.2 in).
    shapes.sort((a, b) => (Math.abs(a.y - b.y) > 180000 ? a.y - b.y : a.x - b.x));
    if (pagePerSlide && paragraphs.length > 0) {
      paragraphs.push({ role: "pageBreak", text: "" });
    }
    for (const shape of shapes) {
      paragraphs.push(...shape.paragraphs);
    }
  }
  return { paragraphs, warnings, slides: slidePaths.length };
}
