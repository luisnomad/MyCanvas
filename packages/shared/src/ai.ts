/*
 * AI setup per workspace: reusable connections (an endpoint plus, maybe, a
 * key) and which connection does text and which does images. Keys never
 * travel to the browser: the server keeps them encrypted and reports only
 * whether one is set.
 */

export type AiConnectionKind = "gemini" | "openai" | "comfyui";

export const AI_CONNECTION_KINDS: { id: AiConnectionKind; label: string; hint: string }[] = [
  { id: "gemini", label: "Google Gemini", hint: "Text and images with a Google AI Studio API key." },
  {
    id: "openai",
    label: "OpenAI-compatible",
    hint: "llama.cpp, vLLM, Ollama, LM Studio, OpenRouter or OpenAI: any server with the /v1 chat API.",
  },
  { id: "comfyui", label: "ComfyUI", hint: "Images from your own ComfyUI server, with a preset or your own workflow." },
];

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
