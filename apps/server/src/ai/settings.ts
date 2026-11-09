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
import { AiSettingsError } from "./errors";
import { LOCAL_USER } from "../auth";
import { type Workspace, readJsonFile, workspaceFor, writeJsonFile } from "../storage";
import { isOwner, mayUseLocalNetwork, resolvesToLocalNetwork } from "./network";

/** Encrypted keys by connection id. */
type StoredSecrets = Record<string, string>;

const MAX_CONNECTIONS = 20;
const MAX_WORKFLOW_BYTES = 256 * 1024;

export { AiSettingsError } from "./errors";

function secretContext(ws: Workspace, connectionId: string): string {
  return `ai-key:${ws.key}:${connectionId}`;
}

/** Ids of the owner's shared connections, as other accounts see them. */
const HOUSE_PREFIX = "house-";

/**
 * The owner's shared connections, offered to accounts allowed on the local
 * network: name and kind only, never the address, key or workflow.
 */
async function houseConnections(email: string): Promise<AiConnection[]> {
  if (isOwner(email) || !(await mayUseLocalNetwork(email))) {
    return [];
  }
  const owner = await workspaceFor(LOCAL_USER);
  const stored = await readJsonFile<AiSettings>(owner.aiFile);
  return (stored?.connections ?? [])
    .filter((connection) => connection.shared === true && connection.runsIn !== "browser")
    .map((connection) => ({ id: `${HOUSE_PREFIX}${connection.id}`, kind: connection.kind, name: connection.name, house: true }));
}

/** The workspace's AI setup as the browser may see it: no keys, only hints. */
export async function readAiSettings(ws: Workspace, email: string): Promise<AiSettings> {
  const stored = await readJsonFile<AiSettings>(ws.aiFile);
  const secrets = (await readJsonFile<StoredSecrets>(ws.aiSecretsFile)) ?? {};
  const own = (stored?.connections ?? []).map((connection) => ({
    ...connection,
    hasKey: connection.id in secrets,
    keyHint: connection.id in secrets ? connection.keyHint : undefined,
  }));
  const connections = [...own, ...await houseConnections(email)];
  // An assignment to a shared connection that's gone (or no longer allowed) reads as off.
  const available = (value: AiAssignment | null | undefined) =>
    value && connections.some((connection) => connection.id === value.connectionId) ? value : null;
  return { connections, text: available(stored?.text), image: available(stored?.image) };
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

function cleanConnection(input: AiConnectionInput, owner: boolean): AiConnection {
  if (typeof input.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(input.id) || input.id.startsWith(HOUSE_PREFIX)) {
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
  if (owner && input.shared === true && connection.runsIn !== "browser") {
    connection.shared = true;
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
export async function saveAiSettings(ws: Workspace, input: AiSettingsInput, email: string): Promise<AiSettings> {
  if (!Array.isArray(input.connections) || input.connections.length > MAX_CONNECTIONS) {
    throw new AiSettingsError("Too many connections.");
  }
  const owner = isOwner(email);
  const mayUseLocal = await mayUseLocalNetwork(email);
  const house = await houseConnections(email);
  const previous = await readJsonFile<AiSettings>(ws.aiFile);
  const secrets = (await readJsonFile<StoredSecrets>(ws.aiSecretsFile)) ?? {};
  const connections: AiConnection[] = [];
  const nextSecrets: StoredSecrets = {};
  for (const raw of input.connections) {
    // Shared connections belong to the owner; they come back from readAiSettings.
    if (raw.house === true || (typeof raw.id === "string" && raw.id.startsWith(HOUSE_PREFIX))) {
      continue;
    }
    const connection = cleanConnection(raw, owner);
    if (!mayUseLocal && connection.runsIn !== "browser" && connection.baseUrl && await resolvesToLocalNetwork(connection.baseUrl)) {
      throw new AiSettingsError(`${connection.name}: that address isn't reachable from the server. For a tool on your own computer, set it to run on "This computer".`);
    }
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
    text: cleanAssignment(input.text, [...connections, ...house], "text"),
    image: cleanAssignment(input.image, [...connections, ...house], "image"),
  };
  await writeJsonFile(ws.aiSecretsFile, nextSecrets);
  await writeJsonFile(ws.aiFile, settings);
  return readAiSettings(ws, email);
}

/** A connection plus its decrypted key, for server-side calls only. */
export async function resolveConnection(ws: Workspace, connectionId: string, email: string): Promise<{ connection: AiConnection; apiKey?: string }> {
  if (connectionId.startsWith(HOUSE_PREFIX)) {
    // The owner's shared connection, read from the owner's own workspace.
    if (isOwner(email) || !(await mayUseLocalNetwork(email))) {
      throw new AiSettingsError("That connection doesn't exist.");
    }
    const owner = await workspaceFor(LOCAL_USER);
    const id = connectionId.slice(HOUSE_PREFIX.length);
    const shared = (await readJsonFile<AiSettings>(owner.aiFile))?.connections.find((entry) => entry.id === id && entry.shared === true);
    if (!shared) {
      throw new AiSettingsError("That shared connection isn't available any more.");
    }
    const sealed = (await readJsonFile<StoredSecrets>(owner.aiSecretsFile))?.[id];
    return { connection: shared, apiKey: sealed ? await decryptSecret(sealed, secretContext(owner, id)) : undefined };
  }
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
