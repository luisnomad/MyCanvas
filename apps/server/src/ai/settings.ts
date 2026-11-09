import {
  type AiAssignment,
  type AiConnection,
  type AiConnectionInput,
  type AiSettings,
  type AiSettingsInput,
  type ComfyWorkflow,
  AI_CONNECTION_KINDS,
  DEFAULT_FLUX_KLEIN,
} from "@mycanvas/shared";
import { decryptSecret, encryptSecret } from "../secrets";
import { type Workspace, readJsonFile, writeJsonFile } from "../storage";

/** Encrypted keys by connection id. */
type StoredSecrets = Record<string, string>;

const MAX_CONNECTIONS = 20;
const MAX_WORKFLOW_BYTES = 256 * 1024;

export class AiSettingsError extends Error {}

function secretContext(ws: Workspace, connectionId: string): string {
  return `ai-key:${ws.key}:${connectionId}`;
}

/** The workspace's AI setup as the browser may see it: no keys, only hints. */
export async function readAiSettings(ws: Workspace): Promise<AiSettings> {
  const stored = await readJsonFile<AiSettings>(ws.aiFile);
  const secrets = (await readJsonFile<StoredSecrets>(ws.aiSecretsFile)) ?? {};
  const connections = (stored?.connections ?? []).map((connection) => ({
    ...connection,
    hasKey: connection.id in secrets,
    keyHint: connection.id in secrets ? connection.keyHint : undefined,
  }));
  return { connections, text: stored?.text ?? null, image: stored?.image ?? null };
}

/**
 * Endpoint URLs: http(s) only, and never the cloud metadata address
 * (a classic way to turn a "fetch this URL" feature against the server).
 */
function cleanBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiSettingsError("Enter the server address, e.g. http://192.168.0.37:11439/v1");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AiSettingsError(`Not a valid address: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AiSettingsError("Addresses must start with http:// or https://");
  }
  if (url.hostname.startsWith("169.254.") || url.hostname === "metadata.google.internal") {
    throw new AiSettingsError("That address isn't allowed.");
  }
  if (url.username || url.password) {
    throw new AiSettingsError("Put credentials in the key field, not in the address.");
  }
  return url.toString().replace(/\/+$/, "");
}

function cleanWorkflow(value: unknown): ComfyWorkflow {
  const workflow = value as Partial<ComfyWorkflow> | undefined;
  if (workflow?.preset === "custom") {
    const text = typeof workflow.workflow === "string" ? workflow.workflow : "";
    if (Buffer.byteLength(text) > MAX_WORKFLOW_BYTES) {
      throw new AiSettingsError("That workflow is too large.");
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
    } catch {
      throw new AiSettingsError("The ComfyUI workflow must be JSON exported with \"Export (API)\".");
    }
    if (!text.includes("{{prompt}}")) {
      throw new AiSettingsError("The workflow needs a {{prompt}} placeholder where the prompt text goes.");
    }
    return { preset: "custom", workflow: text };
  }
  const name = (field: unknown, fallback: string) => (typeof field === "string" && field.trim() ? field.trim().slice(0, 200) : fallback);
  const klein = workflow as Partial<typeof DEFAULT_FLUX_KLEIN> | undefined;
  const steps = Number(klein?.steps);
  return {
    preset: "flux2-klein",
    unet: name(klein?.unet, DEFAULT_FLUX_KLEIN.unet),
    textEncoder: name(klein?.textEncoder, DEFAULT_FLUX_KLEIN.textEncoder),
    vae: name(klein?.vae, DEFAULT_FLUX_KLEIN.vae),
    steps: Number.isInteger(steps) && steps >= 1 && steps <= 60 ? steps : DEFAULT_FLUX_KLEIN.steps,
  };
}

function cleanConnection(input: AiConnectionInput): AiConnection {
  if (typeof input.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(input.id)) {
    throw new AiSettingsError("Invalid connection id.");
  }
  if (!AI_CONNECTION_KINDS.some((kind) => kind.id === input.kind)) {
    throw new AiSettingsError("Unknown connection type.");
  }
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
  const connection: AiConnection = { id: input.id, kind: input.kind, name: name || input.kind };
  if (input.kind !== "gemini") {
    connection.baseUrl = cleanBaseUrl(input.baseUrl);
    connection.allowSelfSigned = input.allowSelfSigned === true;
    if (input.runsIn === "browser") {
      connection.runsIn = "browser";
    }
  }
  if (input.kind === "comfyui") {
    connection.workflow = cleanWorkflow(input.workflow);
  }
  return connection;
}

function cleanAssignment(value: AiAssignment | null, connections: AiConnection[], role: "text" | "image"): AiAssignment | null {
  if (!value) {
    return null;
  }
  const connection = connections.find((entry) => entry.id === value.connectionId);
  if (!connection) {
    throw new AiSettingsError(`The ${role} connection doesn't exist.`);
  }
  if (role === "text" && connection.kind === "comfyui") {
    throw new AiSettingsError("ComfyUI makes images; choose another connection for text.");
  }
  const model = typeof value.model === "string" ? value.model.trim().slice(0, 200) : "";
  if (!model && connection.kind !== "comfyui") {
    throw new AiSettingsError(`Choose a ${role} model.`);
  }
  return { connectionId: connection.id, model };
}

/**
 * Saves the AI setup. A connection's `apiKey` replaces its stored key
 * (null removes it, absent keeps it); keys of removed connections go too.
 */
export async function saveAiSettings(ws: Workspace, input: AiSettingsInput): Promise<AiSettings> {
  if (!Array.isArray(input.connections) || input.connections.length > MAX_CONNECTIONS) {
    throw new AiSettingsError("Too many connections.");
  }
  const previous = await readJsonFile<AiSettings>(ws.aiFile);
  const secrets = (await readJsonFile<StoredSecrets>(ws.aiSecretsFile)) ?? {};
  const connections: AiConnection[] = [];
  const nextSecrets: StoredSecrets = {};
  for (const raw of input.connections) {
    const connection = cleanConnection(raw);
    if (connections.some((entry) => entry.id === connection.id)) {
      throw new AiSettingsError("Duplicate connection id.");
    }
    const existingSecret = secrets[connection.id];
    if (connection.runsIn === "browser") {
      // Keys for tools on the person's computer stay in their browser.
      connections.push(connection);
      continue;
    }
    if (typeof raw.apiKey === "string" && raw.apiKey.trim()) {
      const apiKey = raw.apiKey.trim();
      if (apiKey.length > 4096) {
        throw new AiSettingsError("That key is too long.");
      }
      nextSecrets[connection.id] = await encryptSecret(apiKey, secretContext(ws, connection.id));
      connection.keyHint = apiKey.slice(-4);
    } else if (raw.apiKey !== null && existingSecret) {
      nextSecrets[connection.id] = existingSecret;
      connection.keyHint = previous?.connections.find((entry) => entry.id === connection.id)?.keyHint;
    }
    connections.push(connection);
  }
  const settings: AiSettings = {
    connections,
    text: cleanAssignment(input.text, connections, "text"),
    image: cleanAssignment(input.image, connections, "image"),
  };
  await writeJsonFile(ws.aiSecretsFile, nextSecrets);
  await writeJsonFile(ws.aiFile, settings);
  return readAiSettings(ws);
}

/** A connection plus its decrypted key, for server-side calls only. */
export async function resolveConnection(ws: Workspace, connectionId: string): Promise<{ connection: AiConnection; apiKey?: string }> {
  const settings = await readJsonFile<AiSettings>(ws.aiFile);
  const connection = settings?.connections.find((entry) => entry.id === connectionId);
  if (!connection) {
    throw new AiSettingsError("That connection doesn't exist.");
  }
  if (connection.runsIn === "browser") {
    throw new AiSettingsError(`${connection.name} runs on your computer, so your browser talks to it directly.`);
  }
  const secrets = await readJsonFile<StoredSecrets>(ws.aiSecretsFile);
  const sealed = secrets?.[connectionId];
  return { connection, apiKey: sealed ? await decryptSecret(sealed, secretContext(ws, connectionId)) : undefined };
}
