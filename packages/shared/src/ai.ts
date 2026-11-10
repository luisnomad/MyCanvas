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

export interface AiModelInfo {
  id: string;
  label?: string;
  /** What the model can do, when the provider says. */
  kinds?: ("text" | "image")[];
}

export interface AiImageJob {
  id: string;
  state: "running" | "done" | "error";
  /** Upload file name once done. */
  asset?: string;
  error?: string;
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
