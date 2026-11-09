import {
  AI_IMAGE_NAME_PREFIX,
  type AiConnection,
  type AiModelInfo,
  type AiSettings,
  DEFAULT_FLUX_KLEIN,
  comfyGraph,
  diffusionSize,
} from "@mycanvas/shared";
import { api } from "../api";

/*
 * AI calls from the editor. Connections that run "in the browser" (tools on
 * the person's own computer, e.g. Ollama at localhost) are called directly
 * from here, with any key kept in this browser only; all others go through
 * the MyCanvas server, which holds their keys.
 */

const KEY_PREFIX = "mycanvas-ai-key:";

/** A browser connection's key, stored on this device only. */
export function browserKey(connectionId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + connectionId);
  } catch {
    return null;
  }
}

export function setBrowserKey(connectionId: string, key: string | null): void {
  try {
    if (key) {
      localStorage.setItem(KEY_PREFIX + connectionId, key);
    } else {
      localStorage.removeItem(KEY_PREFIX + connectionId);
    }
  } catch {
    // Storage blocked (private window): the key lasts for this page only.
  }
}

let settingsCache: Promise<AiSettings> | null = null;

/** Call after saving settings so the next AI call sees them. */
export function invalidateAiSettings(): void {
  settingsCache = null;
}

async function assigned(role: "text" | "image"): Promise<{ connection: AiConnection; model: string } | null> {
  settingsCache ??= api.aiSettings();
  const settings = await settingsCache;
  const choice = settings[role];
  const connection = settings.connections.find((entry) => entry.id === choice?.connectionId);
  return choice && connection ? { connection, model: choice.model } : null;
}

/** Explains the usual reasons a browser can't reach a local tool. */
function unreachable(connection: AiConnection): Error {
  const origin = window.location.origin;
  const tips = connection.kind === "comfyui"
    ? "start ComfyUI with --enable-cors-header"
    : `for Ollama set OLLAMA_ORIGINS=${origin}; in LM Studio turn on "Enable CORS"; llama.cpp's server allows it already`;
  const mixed = window.location.protocol === "https:" && connection.baseUrl?.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connection.baseUrl);
  return new Error(mixed
    ? `${connection.name}: this page is HTTPS, so the browser only allows plain-http tools at localhost. Use http://localhost:… or an https address.`
    : `Couldn't reach ${connection.name} from this browser. Is it running, and does it allow this site? (${tips})`);
}

async function browserFetch(connection: AiConnection, path: string, init?: RequestInit): Promise<Response> {
  const key = browserKey(connection.id);
  const headers = new Headers(init?.headers);
  if (key && connection.kind === "openai") {
    headers.set("Authorization", `Bearer ${key}`);
  }
  try {
    return await fetch(`${connection.baseUrl ?? ""}${path}`, { ...init, headers });
  } catch {
    throw unreachable(connection);
  }
}

async function browserJson<T>(connection: AiConnection, path: string, init?: RequestInit): Promise<T> {
  const response = await browserFetch(connection, path, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${connection.name} answered ${String(response.status)}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${connection.name} sent something that isn't JSON.`);
  }
}

function stripFences(text: string): string {
  const fenced = /^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/** Models of a saved connection (also a connection test). */
export async function listAiModels(connection: AiConnection): Promise<AiModelInfo[]> {
  if (connection.runsIn !== "browser") {
    return (await api.aiModels(connection.id)).models;
  }
  if (connection.kind === "comfyui") {
    const files = await browserJson<string[]>(connection, "/models/diffusion_models");
    return files.map((id) => ({ id, kinds: ["image"] }));
  }
  const body = await browserJson<{ data?: { id: string }[] }>(connection, "/models");
  return (body.data ?? []).map((model) => ({ id: model.id, kinds: ["text"] }));
}

export interface TextRequest {
  system: string;
  prompt: string;
  json?: boolean;
  temperature?: number;
}

/** Runs the text model chosen in AI settings. */
export async function aiText(request: TextRequest): Promise<string> {
  const choice = await assigned("text");
  if (choice?.connection.runsIn !== "browser") {
    return (await api.aiText(request)).text;
  }
  const { connection, model } = choice;
  const send = (jsonMode: boolean) => browserJson<{ choices?: { message?: { content?: string } }[] }>(connection, "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: request.temperature ?? 0.2,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  let body;
  try {
    body = await send(Boolean(request.json));
  } catch (error) {
    if (!request.json || !(error instanceof Error) || !error.message.includes(" 400:")) {
      throw error;
    }
    body = await send(false);
  }
  const text = body.choices?.[0]?.message?.content ?? "";
  if (!text) {
    throw new Error(`${connection.name} returned no text.`);
  }
  return stripFences(text);
}

async function uploadGenerated(blob: Blob, name: string): Promise<string> {
  const extension = blob.type.includes("jpeg") ? ".jpg" : blob.type.includes("webp") ? ".webp" : ".png";
  const file = new File([blob], `${AI_IMAGE_NAME_PREFIX}${name.slice(0, 60)}${extension}`, { type: blob.type || "image/png" });
  return (await api.uploadAsset(file)).asset;
}

async function browserComfyImage(connection: AiConnection, prompt: string, width: number, height: number, name: string): Promise<string> {
  const size = diffusionSize(width, height);
  const graph = comfyGraph(connection.workflow ?? DEFAULT_FLUX_KLEIN, prompt, size.width, size.height, Math.floor(Math.random() * 2 ** 31));
  const queued = await browserJson<{ prompt_id?: string; error?: { message?: string } }>(connection, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: crypto.randomUUID() }),
  });
  const promptId = queued.prompt_id;
  if (!promptId) {
    throw new Error(`${connection.name} rejected the workflow: ${queued.error?.message ?? "no prompt id"}`);
  }
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const history = await browserJson<Record<string, {
      status?: { status_str?: string };
      outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
    }>>(connection, `/history/${promptId}`);
    const entry = history[promptId];
    if (entry?.status?.status_str === "error") {
      throw new Error(`${connection.name} failed to run the workflow.`);
    }
    const image = Object.values(entry?.outputs ?? {}).flatMap((output) => output.images ?? []).find((candidate) => candidate.type === "output");
    if (image) {
      const view = await browserFetch(connection, `/view?${new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type }).toString()}`);
      return uploadGenerated(await view.blob(), name);
    }
  }
  throw new Error(`${connection.name} took longer than 10 minutes.`);
}

/** Runs the image model chosen in AI settings; resolves to the new upload's file name. */
export async function aiImage(prompt: string, size: { width: number; height: number }, name: string): Promise<string> {
  const choice = await assigned("image");
  if (choice?.connection.runsIn === "browser") {
    const { connection, model } = choice;
    if (connection.kind === "comfyui") {
      return browserComfyImage(connection, prompt, size.width, size.height, name);
    }
    const snapped = diffusionSize(size.width, size.height);
    const body = await browserJson<{ data?: { b64_json?: string }[] }>(connection, "/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, n: 1, size: `${String(snapped.width)}x${String(snapped.height)}`, response_format: "b64_json" }),
    });
    const b64 = body.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error(`${connection.name} returned no image.`);
    }
    return uploadGenerated(await (await fetch(`data:image/png;base64,${b64}`)).blob(), name);
  }
  const job = await api.startAiImage({ prompt, width: size.width, height: size.height, name });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const state = await api.aiJob(job.id);
    if (state.state === "done" && state.asset) {
      return state.asset;
    }
    if (state.state === "error") {
      throw new Error(state.error ?? "Image generation failed");
    }
  }
  throw new Error("The image took too long.");
}
