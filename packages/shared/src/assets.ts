/** A design or template that references an uploaded asset. */
export interface AssetUsage {
  id: string;
  name: string;
  kind: "design" | "template";
}

/** An uploaded image in the shared library (one per installation). */
export interface AssetInfo {
  /** Server-side file name, served at /assets/<asset>. */
  asset: string;
  /** Display name (original upload file name unless renamed). */
  name: string;
  /** File size in bytes. */
  size: number;
  /** ISO timestamp of the upload. */
  uploadedAt: string;
  /** Produced by an AI tool (cutout / portrait) rather than uploaded by hand. */
  generated: boolean;
  usedIn: AssetUsage[];
}

/** Upload names the in-browser AI tools give their results. */
export const GENERATED_ASSET_NAMES: readonly string[] = ["cutout.png", "portrait.png"];

/** Name prefix of images made by an image model (AI settings). */
export const AI_IMAGE_NAME_PREFIX = "AI image · ";

export function isGeneratedAssetName(name: string): boolean {
  return GENERATED_ASSET_NAMES.includes(name) || name.startsWith(AI_IMAGE_NAME_PREFIX);
}
