/*
 * AI setup per workspace: reusable connections (an endpoint plus, maybe, a
 * key) and which connection does text and which does images. Keys never
 * travel to the browser: the server keeps them encrypted and reports only
 * whether one is set.
 */

export type AiConnectionKind = "gemini" | "openai" | "comfyui" | "kling" | "runway" | "pixverse";

/** Cloud services reached with the owner's own account (log in once; no API key). */
export type AiAccountKind = "kling" | "runway" | "pixverse";

export interface AiConnectionKindInfo {
  id: AiConnectionKind;
  label: string;
  hint: string;
  /** Makes images only. */
  imagesOnly?: boolean;
  /** Signed in with an account instead of a key; only the owner can add these. */
  account?: boolean;
  /** Suggested image model. */
  defaultImageModel?: string;
}

export const AI_CONNECTION_KINDS: AiConnectionKindInfo[] = [
  { id: "gemini", label: "Google Gemini", hint: "Text and images with a Google AI Studio API key." },
  {
    id: "openai",
    label: "OpenAI-compatible",
    hint: "llama.cpp, vLLM, Ollama, LM Studio, OpenRouter or OpenAI: any server with the /v1 chat API.",
  },
  { id: "comfyui", label: "ComfyUI", hint: "Images from your own ComfyUI server, with a preset or your own workflow.", imagesOnly: true },
  { id: "kling", label: "Kling", hint: "Images with your Kling account and its credits. Log in once.", imagesOnly: true, account: true, defaultImageModel: "kling-image-v3_0_omni" },
  { id: "runway", label: "Runway", hint: "Images with your Runway account and its credits. Log in once.", imagesOnly: true, account: true, defaultImageModel: "nano-banana-2.1" },
  { id: "pixverse", label: "PixVerse", hint: "Images with your PixVerse account and its credits. Log in once (every 30 days).", imagesOnly: true, account: true, defaultImageModel: "gpt-image-2.5-flare" },
];

export function connectionKindInfo(kind: AiConnectionKind): AiConnectionKindInfo | undefined {
  return AI_CONNECTION_KINDS.find((entry) => entry.id === kind);
}

export function isAccountKind(kind: AiConnectionKind): kind is AiAccountKind {
  return connectionKindInfo(kind)?.account === true;
}

export function isImagesOnlyKind(kind: AiConnectionKind): boolean {
  return connectionKindInfo(kind)?.imagesOnly === true;
}

/** FLUX klein (2 or 3) through ComfyUI: the model files to use (names as on the server). */
export interface ComfyFluxKleinPreset {
  preset: "flux2-klein" | "flux3-klein";
  unet: string;
  textEncoder: string;
  vae: string;
  steps: number;
}

/**
 * Any ComfyUI workflow exported in API format. These placeholders are
 * replaced: "{{prompt}}", "{{width}}", "{{height}}", "{{seed}}" (numbers
 * may be written as the bare string). The first SaveImage output is used.
 */
export interface ComfyCustomWorkflow {
  preset: "custom";
  workflow: string;
}

export type ComfyWorkflow = ComfyFluxKleinPreset | ComfyCustomWorkflow;

export const DEFAULT_FLUX_KLEIN: ComfyFluxKleinPreset = {
  preset: "flux2-klein",
  unet: "flux-2-klein-4b.safetensors",
  textEncoder: "qwen_3_4b.safetensors",
  vae: "flux2-vae.safetensors",
  steps: 4,
};

/** FLUX 3 klein, distilled int8, as in BFL's ComfyUI workflows. */
export const DEFAULT_FLUX3_KLEIN: ComfyFluxKleinPreset = {
  preset: "flux3-klein",
  unet: "flux3-image-klein-int8-convrot.safetensors",
  textEncoder: "qwen3vl_4b_bf16.safetensors",
  vae: "flux2-vae.safetensors",
  steps: 16,
};

export interface AiConnection {
  id: string;
  kind: AiConnectionKind;
  name: string;
  /** Endpoint for openai/comfyui, e.g. http://192.168.0.37:11439/v1. */
  baseUrl?: string;
  /** Accept a self-signed certificate (local servers over HTTPS). */
  allowSelfSigned?: boolean;
  /**
   * Who calls the endpoint. "server" (default): the MyCanvas server, which
   * reaches cloud APIs and machines on its own network. "browser": the
   * person's browser, for tools on their own computer (Ollama, LM Studio,
   * ComfyUI at localhost); any key then stays in that browser.
   */
  runsIn?: "server" | "browser";
  /** ComfyUI only. */
  workflow?: ComfyWorkflow;
  /** Owner only: offered (by name only) to accounts allowed on the local network. */
  shared?: boolean;
  /** Set by the server: the owner's shared connection, usable but not editable here. */
  house?: boolean;
  /** Set by the server: a key is stored. */
  hasKey?: boolean;
  /** Set by the server: last 4 characters of the stored key, for recognition. */
  keyHint?: string;
  /** Set by the server, account kinds: when the login was made and when it runs out (ISO dates). */
  account?: { connectedAt: string; expiresAt?: string };
}

export interface AiAssignment {
  connectionId: string;
  /** Model id as the provider names it; ComfyUI ignores it (the workflow decides). */
  model: string;
}

export interface AiSettings {
  connections: AiConnection[];
  text: AiAssignment | null;
  image: AiAssignment | null;
}

/** Saving settings: a connection may carry a new key (string) or a request to remove it (null). */
export type AiConnectionInput = AiConnection & { apiKey?: string | null };

export interface AiSettingsInput {
  connections: AiConnectionInput[];
  text: AiAssignment | null;
  image: AiAssignment | null;
}

/** What an image model accepts: aspect ratios ("16:9"), output sizes (the service's own names) and transparency. */
export interface AiImageOptions {
  ratios: string[];
  sizes: string[];
  defaultSize?: string;
  /** The model can make a transparent background itself. */
  transparent?: boolean;
}

export interface AiModelInfo {
  id: string;
  label?: string;
  /** What the model can do, when the provider says. */
  kinds?: ("text" | "image")[];
  /** Image models: their own ratios and sizes, when the service lists them. */
  image?: AiImageOptions;
}

/** Asking for a picture. Without `connectionId` the Images choice in AI settings is used. */
export interface AiImageRequest {
  prompt: string;
  width: number;
  height: number;
  name?: string;
  connectionId?: string;
  model?: string;
  /** One of the model's ratios. */
  ratio?: string;
  /** One of the model's sizes. */
  size?: string;
  /** Ask the model for a transparent background (only when it can make one). */
  transparent?: boolean;
  /** false: hold the picture for /api/ai/jobs/:id/image instead of adding it to uploads. */
  keep?: boolean;
}

export interface AiImageJob {
  id: string;
  state: "running" | "done" | "error";
  /** Upload file name once done (when kept). */
  asset?: string;
  error?: string;
}

const COMMON_RATIOS = ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"];

/** Long side in pixels for the sizes MyCanvas offers where a service has no names of its own. */
export const PIXEL_SIZES: Record<string, number> = { "1K": 1024, "1.5K": 1536, "2K": 2048 };

/**
 * The ratios and sizes to offer for a model: the service's own list when it
 * gave one, else what that kind of connection takes.
 */
export function imageOptionsFor(kind: AiConnectionKind, model: AiModelInfo | undefined): AiImageOptions {
  if (model?.image) {
    return model.image;
  }
  if (kind === "gemini") {
    // Gemini 3 image models take 1K/2K/4K; older ones make about 1K.
    const sized = /gemini-3|pro-image/i.test(model?.id ?? "");
    return { ratios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"], sizes: sized ? ["1K", "2K", "4K"] : [], defaultSize: sized ? "1K" : undefined };
  }
  return { ratios: COMMON_RATIOS, sizes: Object.keys(PIXEL_SIZES), defaultSize: "1K" };
}

/** Width and height for a ratio ("16:9") with the long side `longSide` pixels. */
export function ratioSize(ratio: string, longSide: number): { width: number; height: number } {
  const [w = 1, h = 1] = ratio.split(":").map(Number);
  const scale = longSide / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** Logging in to an account connection: open `url` (and, for some services, confirm `code`). */
export interface AiLoginStart {
  id: string;
  url: string;
  code?: string;
}

export interface AiLoginStatus {
  state: "waiting" | "done" | "error";
  error?: string;
}

export interface AiCredits {
  /** Credits left, when the service says. */
  credits: number | null;
  /** Plan or membership name, when known. */
  plan?: string;
}
