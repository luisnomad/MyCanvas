/** Uploads an image found in an imported file; resolves to its asset file name. */
export type ImageUploader = (blob: Blob, name: string) => Promise<string>;

export interface ImportOptions {
  /** PPTX/PDF: start a new page for each slide or page of the source. */
  pagePerSourcePage: boolean;
}

export interface ImportResult {
  markdown: string;
  /** One line describing what was found, e.g. "10 slides · 10 headings · 44 paragraphs". */
  summary: string;
  warnings: string[];
}
