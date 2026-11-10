import { randomInt, randomUUID } from "node:crypto";
import { type AiConnection, type AiModelInfo, comfyGraph, diffusionSize } from "@mycanvas/shared";
import { Agent, fetch as undiciFetch } from "undici";

/*
 * Calls to AI providers, made by the server so keys never reach browsers.
 * Three kinds of connection:
 * - gemini: Google's Generative Language API (text and images).
 * - openai: any server speaking the OpenAI /v1 API (llama.cpp, vLLM,
 *   Ollama, LM Studio, OpenRouter, OpenAI): chat, and images where offered.
 * - comfyui: a ComfyUI server running a workflow (images).
 */

export class ProviderError extends Error {}

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

/** Only for connections that opted in: accept a self-signed certificate. */
const selfSignedAgent = new Agent({ connect: { rejectUnauthorized: false } });

interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

async function call(connection: AiConnection, url: string, options: CallOptions = {}) {
  try {
    return await undiciFetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      dispatcher: connection.allowSelfSigned ? selfSignedAgent : undefined,
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || cause?.code === "SELF_SIGNED_CERT_IN_CHAIN") {
      throw new ProviderError(`${connection.name}: the server's certificate isn't trusted. If it's your own server, tick "Accept a self-signed certificate".`);
    }
    if ((error as Error).name === "TimeoutError") {
      throw new ProviderError(`${connection.name} didn't answer in time.`);
    }
    throw new ProviderError(`Couldn't reach ${connection.name} (${cause?.code ?? cause?.message ?? (error as Error).message}).`);
  }
}

/** JSON from a response, or a readable error with the provider's own message. */
async function json<T>(connection: AiConnection, response: Awaited<ReturnType<typeof call>>): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = (body as { error?: { message?: string } | string } | null)?.error;
    const message = typeof detail === "string" ? detail : detail?.message ?? text.slice(0, 200);
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(`${connection.name} refused the key (${String(response.status)}): ${message}`);
    }
    throw new ProviderError(`${connection.name} answered ${String(response.status)}: ${message}`);
  }
  if (body === null) {
    throw new ProviderError(`${connection.name} sent something that isn't JSON.`);
  }
  return body as T;
}

function geminiHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) {
    throw new ProviderError("This Gemini connection has no API key.");
  }
  return { "x-goog-api-key": apiKey, "Content-Type": "application/json" };
}

function openaiHeaders(apiKey: string | undefined): Record<string, string> {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

function base(connection: AiConnection): string {
  if (!connection.baseUrl) {
    throw new ProviderError(`${connection.name} has no address.`);
  }
  return connection.baseUrl;
}

/* -------------------------------------------------------------------- */
/* Models                                                               */
/* -------------------------------------------------------------------- */

export async function listModels(connection: AiConnection, apiKey?: string): Promise<AiModelInfo[]> {
  switch (connection.kind) {
    case "gemini": {
      const body = await json<{ models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] }>(
        connection,
        await call(connection, `${GEMINI}/models?pageSize=200`, { headers: geminiHeaders(apiKey) }),
      );
      return (body.models ?? [])
        .filter((model) => (model.supportedGenerationMethods ?? []).some((method) => method === "generateContent" || method === "predict"))
        .map((model) => {
          const id = model.name.replace(/^models\//, "");
          const image = /image|imagen/i.test(id);
          return { id, label: model.displayName, kinds: image ? ["image"] : ["text"] };
        });
    }
    case "openai": {
      const body = await json<{ data?: { id: string }[] }>(connection, await call(connection, `${base(connection)}/models`, { headers: openaiHeaders(apiKey) }));
      return (body.data ?? []).map((model) => ({
        id: model.id,
        kinds: /image|dall-e|flux|sdxl|diffusion/i.test(model.id) ? ["image"] : ["text"],
      }));
    }
    case "comfyui": {
      // The image model files the server has (for the FLUX.2 klein preset).
      const body = await json<string[]>(connection, await call(connection, `${base(connection)}/models/diffusion_models`));
      return body.map((id) => ({ id, kinds: ["image"] }));
    }
    default:
      throw new ProviderError(`${connection.name} signs in with an account; its models come from the account.`);
  }
}

/* -------------------------------------------------------------------- */
/* Text                                                                 */
/* -------------------------------------------------------------------- */

export interface TextRequest {
  system: string;
  prompt: string;
  /** Ask for a JSON answer (fences are stripped either way). */
  json?: boolean;
  /** Pictures for vision models, as data: URLs (PNG/JPEG/WebP). */
  images?: string[];
  temperature?: number;
}

function stripFences(text: string): string {
  const fenced = /^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text);
  return (fenced?.[1] ?? text).trim();
}

export async function generateText(connection: AiConnection, apiKey: string | undefined, model: string, request: TextRequest): Promise<string> {
  const temperature = request.temperature ?? 0.2;
  if (connection.kind === "gemini") {
    const body = await json<{ candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] }>(
      connection,
      await call(connection, `${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: geminiHeaders(apiKey),
        timeoutMs: 180_000,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{
            role: "user",
            parts: [
              { text: request.prompt },
              ...(request.images ?? []).map((url) => {
                const [, mimeType = "image/jpeg", data = ""] = /^data:([^;]+);base64,(.*)$/s.exec(url) ?? [];
                return { inlineData: { mimeType, data } };
              }),
            ],
          }],
          generationConfig: { temperature, ...(request.json ? { responseMimeType: "application/json" } : {}) },
        }),
      }),
    );
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (!text) {
      throw new ProviderError(`${connection.name} returned no text (${body.candidates?.[0]?.finishReason ?? "empty answer"}).`);
    }
    return stripFences(text);
  }
  if (connection.kind === "openai") {
    const send = async (jsonMode: boolean) => json<{ choices?: { message?: { content?: string } }[] }>(
      connection,
      await call(connection, `${base(connection)}/chat/completions`, {
        method: "POST",
        headers: openaiHeaders(apiKey),
        timeoutMs: 180_000,
        body: JSON.stringify({
          model,
          temperature,
          messages: [
            { role: "system", content: request.system },
            {
              role: "user",
              content: request.images?.length
                ? [{ type: "text", text: request.prompt }, ...request.images.map((url) => ({ type: "image_url", image_url: { url } }))]
                : request.prompt,
            },
          ],
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      }),
    );
    let body;
    try {
      body = await send(Boolean(request.json));
    } catch (error) {
      // Some servers don't support JSON mode; the prompt still asks for JSON.
      if (!request.json || !(error instanceof ProviderError) || !error.message.includes(" 400:")) {
        throw error;
      }
      body = await send(false);
    }
    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text) {
      throw new ProviderError(`${connection.name} returned no text.`);
    }
    return stripFences(text);
  }
  throw new ProviderError("ComfyUI makes images, not text.");
}

/* -------------------------------------------------------------------- */
/* Images                                                               */
/* -------------------------------------------------------------------- */

export interface ImageRequest {
  prompt: string;
  width: number;
  height: number;
}

export interface GeneratedImage {
  bytes: Buffer;
  extension: string;
}

const GEMINI_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "4:5", "5:4", "21:9"];

/** The supported aspect ratio closest to width:height. */
function nearestRatio(width: number, height: number): string {
  const wanted = Math.log(width / height);
  let best = "1:1";
  let distance = Infinity;
  for (const ratio of GEMINI_RATIOS) {
    const [w = 1, h = 1] = ratio.split(":").map(Number);
    const d = Math.abs(Math.log(w / h) - wanted);
    if (d < distance) {
      best = ratio;
      distance = d;
    }
  }
  return best;
}

function extensionFor(mime: string): string {
  return mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : mime.includes("webp") ? ".webp" : ".png";
}

interface ComfyHistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] };
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
}

async function comfyImage(connection: AiConnection, request: ImageRequest): Promise<GeneratedImage> {
  const url = base(connection);
  const { width, height } = diffusionSize(request.width, request.height);
  const graph = comfyGraph(connection.workflow ?? { preset: "flux2-klein", unet: "", textEncoder: "", vae: "", steps: 4 }, request.prompt, width, height, randomInt(1, 2 ** 31));
  const queued = await json<{ prompt_id?: string; error?: { message?: string }; node_errors?: unknown }>(
    connection,
    await call(connection, `${url}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
    }),
  );
  const promptId = queued.prompt_id;
  if (!promptId) {
    throw new ProviderError(`${connection.name} rejected the workflow: ${queued.error?.message ?? "no prompt id"}`);
  }
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const history = await json<Record<string, ComfyHistoryEntry>>(connection, await call(connection, `${url}/history/${promptId}`));
    const entry = history[promptId];
    if (entry?.status?.status_str === "error") {
      const failure = entry.status.messages?.find(([kind]) => kind === "execution_error")?.[1].exception_message;
      throw new ProviderError(`${connection.name} failed: ${failure ?? "workflow error"}`);
    }
    const image = Object.values(entry?.outputs ?? {}).flatMap((output) => output.images ?? []).find((candidate) => candidate.type === "output");
    if (image) {
      const view = await call(connection, `${url}/view?${new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type }).toString()}`);
      if (!view.ok) {
        throw new ProviderError(`${connection.name} made the image but couldn't send it (${String(view.status)}).`);
      }
      return { bytes: Buffer.from(await view.arrayBuffer()), extension: extensionFor(view.headers.get("content-type") ?? "image/png") };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new ProviderError(`${connection.name} took longer than 10 minutes.`);
}

export async function generateImage(connection: AiConnection, apiKey: string | undefined, model: string, request: ImageRequest): Promise<GeneratedImage> {
  if (connection.kind === "comfyui") {
    return comfyImage(connection, request);
  }
  if (connection.kind === "gemini") {
    const body = await json<{ candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; text?: string }[] }; finishReason?: string }[] }>(
      connection,
      await call(connection, `${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: geminiHeaders(apiKey),
        timeoutMs: 300_000,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: nearestRatio(request.width, request.height) } },
        }),
      }),
    );
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    const image = parts.find((part) => part.inlineData)?.inlineData;
    if (!image) {
      const said = parts.map((part) => part.text ?? "").join(" ").trim();
      throw new ProviderError(`${connection.name} returned no image${said ? `: ${said.slice(0, 200)}` : ` (${body.candidates?.[0]?.finishReason ?? "empty answer"})`}.`);
    }
    return { bytes: Buffer.from(image.data, "base64"), extension: extensionFor(image.mimeType) };
  }
  // OpenAI-compatible image endpoint (OpenAI, and servers that copy it).
  const size = diffusionSize(request.width, request.height);
  const body = await json<{ data?: { b64_json?: string; url?: string }[] }>(
    connection,
    await call(connection, `${base(connection)}/images/generations`, {
      method: "POST",
      headers: openaiHeaders(apiKey),
      timeoutMs: 300_000,
      body: JSON.stringify({ model, prompt: request.prompt, n: 1, size: `${String(size.width)}x${String(size.height)}` }),
    }),
  );
  const first = body.data?.[0];
  if (first?.b64_json) {
    return { bytes: Buffer.from(first.b64_json, "base64"), extension: ".png" };
  }
  if (first?.url) {
    const download = await call(connection, first.url);
    return { bytes: Buffer.from(await download.arrayBuffer()), extension: extensionFor(download.headers.get("content-type") ?? "image/png") };
  }
  throw new ProviderError(`${connection.name} returned no image.`);
}
