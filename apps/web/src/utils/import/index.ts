import { paragraphsToMarkdown } from "./classify";
import { type ImageUploader, type ImportOptions, type ImportResult } from "./types";

export type { ImageUploader, ImportOptions, ImportResult } from "./types";

export const IMPORT_ACCEPT = ".docx,.pptx,.pdf,.md,.markdown,.txt";

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Reads a file into format content (Markdown dialect). Readers load on
 * demand, so their libraries only download when someone imports.
 */
export async function importContentFile(file: File, upload: ImageUploader, options: ImportOptions): Promise<ImportResult> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "md" || extension === "markdown" || extension === "txt") {
    const markdown = await file.text();
    return { markdown, summary: `${file.name}: ${plural(markdown.split("\n").filter((line) => line.trim()).length, "line")} of text`, warnings: [] };
  }
  let read: { paragraphs: Parameters<typeof paragraphsToMarkdown>[0]; warnings: string[] };
  let unit = "";
  if (extension === "docx") {
    const { readDocx } = await import("./read-docx");
    read = await readDocx(file, upload);
  } else if (extension === "pptx") {
    const { readPptx } = await import("./read-pptx");
    const result = await readPptx(file, upload, options.pagePerSourcePage);
    read = result;
    unit = plural(result.slides, "slide");
  } else if (extension === "pdf") {
    const { readPdf } = await import("./read-pdf");
    const result = await readPdf(file, options.pagePerSourcePage);
    read = result;
    unit = plural(result.pages, "page");
  } else {
    throw new Error("Import works with Word (.docx), PowerPoint (.pptx), PDF and Markdown/text files.");
  }
  const { markdown, stats } = paragraphsToMarkdown(read.paragraphs, { detectTitle: extension !== "pptx" });
  const parts = [
    unit,
    stats.hasTitle ? "a title" : "",
    plural(stats.headings, "heading"),
    plural(stats.paragraphs, "paragraph"),
    stats.images > 0 ? plural(stats.images, "image") : "",
  ].filter(Boolean);
  return { markdown, summary: `${file.name}: ${parts.join(" · ")}`, warnings: read.warnings };
}
