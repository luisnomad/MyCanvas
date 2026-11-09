import mammoth from "mammoth";
import { type RawParagraph } from "./classify";
import { type ImageUploader } from "./types";

/** Word styles mammoth doesn't map by default. */
const STYLE_MAP = [
  "p[style-name='Title'] => p.mc-title:fresh",
  "p[style-name='Subtitle'] => p.mc-subtitle:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
];

/** True when every bit of text in the element sits inside <strong>/<b>. */
function allBold(element: Element): boolean {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let sawText = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) {
      continue;
    }
    sawText = true;
    if (!node.parentElement?.closest("strong, b")) {
      return false;
    }
  }
  return sawText;
}

/** Text with line breaks (<br>) kept as spaces. */
function textOf(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll("br").forEach((br) => { br.replaceWith(" "); });
  return copy.textContent ?? "";
}

function readElement(element: Element, out: RawParagraph[]): void {
  const tag = element.tagName.toLowerCase();
  // Images anywhere in the element come first, in order.
  const images = tag === "img" ? [element] : [...element.querySelectorAll("img")];
  for (const image of images) {
    const asset = image.getAttribute("src");
    if (asset) {
      out.push({ role: "image", text: image.getAttribute("alt") ?? "", asset });
    }
  }
  if (tag === "img") {
    return;
  }
  if (/^h[1-6]$/.test(tag)) {
    out.push({ role: "heading", text: textOf(element) });
  } else if (tag === "p") {
    const text = textOf(element);
    if (element.classList.contains("mc-title")) {
      out.push({ role: "title", text });
    } else if (element.classList.contains("mc-subtitle")) {
      out.push({ role: "subtitle", text });
    } else {
      out.push({ text, bold: allBold(element) });
    }
  } else if (tag === "ul" || tag === "ol") {
    for (const item of element.querySelectorAll("li")) {
      // Nested lists are read as their own items; take this item's own text.
      const own = item.cloneNode(true) as Element;
      own.querySelectorAll("ul, ol").forEach((list) => { list.remove(); });
      out.push({ role: "listItem", text: textOf(own) });
    }
  } else if (tag === "blockquote") {
    for (const paragraph of element.children.length > 0 ? [...element.children] : [element]) {
      out.push({ role: "quote", text: textOf(paragraph) });
    }
  } else if (tag === "table") {
    const cells = [...element.querySelectorAll("td, th")];
    // Tables used for layout (cells holding several paragraphs) read as
    // ordinary content, cell by cell; data tables stay one line per row.
    if (cells.some((cell) => cell.querySelectorAll(":scope > p").length > 1)) {
      for (const cell of cells) {
        for (const child of cell.children) {
          readElement(child, out);
        }
      }
      return;
    }
    for (const row of element.querySelectorAll("tr")) {
      const cells = [...row.querySelectorAll("td, th")].map((cell) => textOf(cell).replace(/\s+/g, " ").trim()).filter(Boolean);
      if (cells.length > 0) {
        out.push({ text: cells.join(" · ") });
      }
    }
  } else {
    for (const child of element.children) {
      readElement(child, out);
    }
  }
}

export async function readDocx(file: File, upload: ImageUploader): Promise<{ paragraphs: RawParagraph[]; warnings: string[] }> {
  const warnings: string[] = [];
  let imageCount = 0;
  const result = await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    {
      styleMap: STYLE_MAP,
      convertImage: mammoth.images.imgElement(async (image) => {
        imageCount += 1;
        const bytes = await image.readAsArrayBuffer();
        const extension = image.contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        try {
          const asset = await upload(new Blob([bytes], { type: image.contentType }), `${file.name.replace(/\.[^.]+$/, "")} image ${String(imageCount)}.${extension}`);
          return { src: asset };
        } catch {
          warnings.push(`Image ${String(imageCount)} couldn't be uploaded (${image.contentType}).`);
          return { src: "" };
        }
      }),
    },
  );
  const doc = new DOMParser().parseFromString(`<body>${result.value}</body>`, "text/html");
  const paragraphs: RawParagraph[] = [];
  for (const element of doc.body.children) {
    readElement(element, paragraphs);
  }
  return { paragraphs, warnings };
}
