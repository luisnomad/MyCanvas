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
