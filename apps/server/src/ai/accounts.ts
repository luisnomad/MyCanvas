import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import { type AiAccountKind, type AiConnection, type AiCredits, type AiLoginStart, type AiLoginStatus, type AiModelInfo, type AiSettings } from "@mycanvas/shared";
import { encryptSecret } from "../secrets";
import { type Workspace, dataDir, readJsonFile, writeJsonFile } from "../storage";
import { AiSettingsError } from "./errors";
import { type GeneratedImage, type ImageRequest, ProviderError } from "./providers";
import { secretContext } from "./settings";

/*
 * Cloud services reached with the owner's own account rather than an API
 * key, so their plan credits pay for the pictures:
 * - Kling and Runway: their MCP servers, with the standard MCP login
 *   (OAuth with PKCE; MyCanvas registers itself and gets the code back on
 *   /api/ai/oauth/callback). Tokens refresh on their own.
 * - PixVerse: its creative platform API with a device login (open a page,
 *   approve; the token lasts 30 days and can't be refreshed).
 * Tokens are stored encrypted like API keys and never leave the server.
 */

interface AccountToken {
  access: string;
  refresh?: string;
  /** Epoch ms. */
  expiresAt?: number;
  clientId?: string;
  tokenEndpoint?: string;
}

interface OAuthService {
  mcp: string;
  metadata: string;
  scope: string;
}

const OAUTH: Record<"kling" | "runway", OAuthService> = {
  kling: {
    mcp: "https://kling.ai/mcp",
    metadata: "https://kling.ai/.well-known/oauth-authorization-server/auth",
    scope: "generation.create generation.read account.credit.read",
  },
  runway: {
    mcp: "https://mcp.runwayml.com/mcp",
    metadata: "https://mcp.runwayml.com/.well-known/oauth-authorization-server",
    scope: "openid api:read_write",
  },
};

const PIXVERSE = "https://app-api.pixverse.ai/creative_platform";

const SERVICE_NAMES: Record<AiAccountKind, string> = { kling: "Kling", runway: "Runway", pixverse: "PixVerse" };

/** OAuth clients MyCanvas registered, by service and return address (not secret). */
const clientsFile = path.join(dataDir, "ai-oauth-clients.json");

/* -------------------------------------------------------------------- */
/* HTTP                                                                 */
/* -------------------------------------------------------------------- */

async function send(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") {
      throw new ProviderError(`${new URL(url).hostname} didn't answer in time.`);
    }
    throw new ProviderError(`Couldn't reach ${new URL(url).hostname} (${(error as Error).message}).`);
  }
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!response.ok) {
    const detail = body as { error_description?: string; error?: string; message?: string } | null;
    throw new ProviderError(`${what} answered ${String(response.status)}: ${detail?.error_description ?? detail?.message ?? detail?.error ?? text.slice(0, 200)}`);
  }
  if (body === null) {
    throw new ProviderError(`${what} sent something that isn't JSON.`);
  }
  return body as T;
}

/* -------------------------------------------------------------------- */
/* Stored logins                                                        */
/* -------------------------------------------------------------------- */

function parseToken(raw: string | undefined, connection: AiConnection): AccountToken {
  if (!raw) {
    throw new ProviderError(`${connection.name} isn't logged in. Open AI settings and log in.`);
  }
  try {
    const token = JSON.parse(raw) as AccountToken;
    if (typeof token.access === "string" && token.access) {
      return token;
    }
  } catch {
    // fall through
  }
  throw new ProviderError(`${connection.name}: the stored login is unreadable. Log in again in AI settings.`);
}

/** Expiry from a JWT's `exp`, without verifying it (only to warn before it runs out). */
function jwtExpiry(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) {
    return undefined;
  }
  try {
    const exp = (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number }).exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

async function storeToken(ws: Workspace, connectionId: string, token: AccountToken, fresh: boolean): Promise<void> {
  const secrets = (await readJsonFile<Record<string, string>>(ws.aiSecretsFile)) ?? {};
  secrets[connectionId] = await encryptSecret(JSON.stringify(token), secretContext(ws, connectionId));
  await writeJsonFile(ws.aiSecretsFile, secrets);
  const settings = await readJsonFile<AiSettings>(ws.aiFile);
  const connection = settings?.connections.find((entry) => entry.id === connectionId);
  if (settings && connection) {
    // OAuth logins refresh themselves; only PixVerse's runs out for good.
    const expiresAt = connection.kind === "pixverse" && token.expiresAt ? new Date(token.expiresAt).toISOString() : undefined;
    connection.account = {
      connectedAt: fresh || !connection.account ? new Date().toISOString() : connection.account.connectedAt,
      ...(expiresAt ? { expiresAt } : {}),
    };
    await writeJsonFile(ws.aiFile, settings);
  }
}

const refreshing = new Map<string, Promise<AccountToken>>();

async function refreshToken(ws: Workspace, connection: AiConnection, token: AccountToken): Promise<AccountToken> {
  if (!token.refresh || !token.tokenEndpoint || !token.clientId) {
    throw new ProviderError(`${connection.name}: the login has expired. Log in again in AI settings.`);
  }
  const service = OAUTH[connection.kind as "kling" | "runway"];
  const response = await send(token.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh, client_id: token.clientId, resource: service.mcp }).toString(),
  });
  if (response.status === 400 || response.status === 401) {
    throw new ProviderError(`${connection.name}: the login has expired. Log in again in AI settings.`);
  }
  const body = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number }>(response, connection.name);
  if (!body.access_token) {
    throw new ProviderError(`${connection.name} didn't renew the login. Log in again in AI settings.`);
  }
  const next: AccountToken = {
    ...token,
    access: body.access_token,
    // Refresh tokens rotate: the old one stops working now.
    refresh: body.refresh_token ?? token.refresh,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : jwtExpiry(body.access_token),
  };
  await storeToken(ws, connection.id, next, false);
  return next;
}

/** A usable access token, renewed first when it's about to run out (one renewal at a time). */
async function accessToken(ws: Workspace, connection: AiConnection, raw: string | undefined, force = false): Promise<string> {
  const token = parseToken(raw, connection);
  const stale = token.expiresAt !== undefined && token.expiresAt - 60_000 < Date.now();
  if (!force && !stale) {
    return token.access;
  }
  if (connection.kind === "pixverse") {
    throw new ProviderError(`${connection.name}: the login ran out (PixVerse logins last 30 days). Log in again in AI settings.`);
  }
  const key = `${ws.key}:${connection.id}`;
  let pending = refreshing.get(key);
  if (!pending) {
    pending = refreshToken(ws, connection, token).finally(() => { refreshing.delete(key); });
    refreshing.set(key, pending);
  }
  return (await pending).access;
}

/* -------------------------------------------------------------------- */
/* Logging in                                                           */
/* -------------------------------------------------------------------- */

interface Login {
  id: string;
  ws: Workspace;
  email: string;
  connection: AiConnection;
  state: AiLoginStatus["state"];
  error?: string;
  createdAt: number;
  /** OAuth. */
  oauth?: { verifier: string; clientId: string; redirectUri: string; tokenEndpoint: string };
}

const LOGIN_TTL_MS = 15 * 60_000;
const logins = new Map<string, Login>();

function pruneLogins() {
  for (const [id, login] of logins) {
    if (login.createdAt + LOGIN_TTL_MS < Date.now()) {
      logins.delete(id);
    }
  }
}

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/** Registers MyCanvas with the service once per return address (dynamic client registration). */
async function clientFor(kind: "kling" | "runway", metadata: AuthServerMetadata, redirectUri: string): Promise<string> {
  const key = `${kind} ${redirectUri}`;
  const clients = (await readJsonFile<Record<string, string>>(clientsFile)) ?? {};
  const known = clients[key];
  if (known) {
    return known;
  }
  if (!metadata.registration_endpoint) {
    throw new ProviderError(`${SERVICE_NAMES[kind]} doesn't let apps register.`);
  }
  const body = await readJson<{ client_id?: string }>(
    await send(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        client_name: "MyCanvas",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
    SERVICE_NAMES[kind],
  );
  if (!body.client_id) {
    throw new ProviderError(`${SERVICE_NAMES[kind]} didn't register MyCanvas.`);
  }
  clients[key] = body.client_id;
  await writeJsonFile(clientsFile, clients);
  return body.client_id;
}

/** Where the service sends the browser back: this server, as the person's browser reaches it. */
export function callbackUrl(origin: string): string {
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) {
    throw new AiSettingsError("Couldn't tell this page's address; reload and try again.");
  }
  return `${origin}/api/ai/oauth/callback`;
}

/** Starts a login; the browser opens `url` and then polls the login's state. */
export async function startLogin(ws: Workspace, email: string, connection: AiConnection, origin: string): Promise<AiLoginStart> {
  pruneLogins();
  const login: Login = { id: randomUUID(), ws, email, connection, state: "waiting", createdAt: Date.now() };
  if (connection.kind === "kling" || connection.kind === "runway") {
    const service = OAUTH[connection.kind];
    const metadata = await readJson<AuthServerMetadata>(await send(service.metadata, { headers: { Accept: "application/json" } }), connection.name);
    const redirectUri = callbackUrl(origin);
    const clientId = await clientFor(connection.kind, metadata, redirectUri);
    const verifier = randomBytes(32).toString("base64url");
    login.oauth = { verifier, clientId, redirectUri, tokenEndpoint: metadata.token_endpoint };
    logins.set(login.id, login);
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: service.scope,
      state: login.id,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: service.mcp,
    }).toString();
    return { id: login.id, url: url.toString() };
  }
  if (connection.kind === "pixverse") {
    const started = await pixverseCall<{ device_code?: string; user_code?: string; verification_uri_complete?: string; verification_uri?: string; interval?: number; expires_in?: number }>(
      connection,
      "oauth/device/authorize",
      null,
      {},
    );
    if (!started.device_code || !(started.verification_uri_complete ?? started.verification_uri)) {
      throw new ProviderError("PixVerse didn't start a login.");
    }
    logins.set(login.id, login);
    void waitForDevice(login, started.device_code, Math.max(2, started.interval ?? 5), Math.min(900, started.expires_in ?? 600));
    return { id: login.id, url: started.verification_uri_complete ?? started.verification_uri ?? "", code: started.user_code };
  }
  throw new AiSettingsError(`${connection.name} doesn't use a login.`);
}

async function waitForDevice(login: Login, deviceCode: string, intervalSeconds: number, expiresSeconds: number) {
  const deadline = Date.now() + expiresSeconds * 1000;
  try {
    while (Date.now() < deadline && logins.get(login.id) === login) {
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
      const body = await pixverseRaw("oauth/device/token", null, { device_code: deviceCode });
      if (body.ErrCode === 10055) {
        continue;
      }
      if (body.ErrCode !== 0) {
        throw new ProviderError(`PixVerse: ${body.ErrMsg ?? "the login was refused"}.`);
      }
      const access = findString(body.Resp, /^(token|access_?token)$/i);
      if (!access) {
        throw new ProviderError("PixVerse approved the login but sent no token.");
      }
      await storeToken(login.ws, login.connection.id, { access, expiresAt: jwtExpiry(access) ?? Date.now() + 30 * 86_400_000 }, true);
      login.state = "done";
      return;
    }
    if (login.state === "waiting") {
      throw new ProviderError("The PixVerse login wasn't approved in time. Try again.");
    }
  } catch (error) {
    login.state = "error";
    login.error = error instanceof Error ? error.message : "The login failed.";
  }
}

/** Finishes an OAuth login when the service sends the browser back. */
export async function finishOAuthLogin(state: string, code: string | undefined, refusal: string | undefined, email: string): Promise<Login> {
  const login = logins.get(state);
  if (!login?.oauth || login.email !== email || login.state !== "waiting") {
    throw new AiSettingsError("This login link has expired or was already used. Start again from AI settings.");
  }
  try {
    if (refusal || !code) {
      throw new ProviderError(refusal === "access_denied" ? "The login was cancelled." : `The login failed (${refusal ?? "no code"}).`);
    }
    const service = OAUTH[login.connection.kind as "kling" | "runway"];
    const body = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number }>(
      await send(login.oauth.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: login.oauth.redirectUri,
          client_id: login.oauth.clientId,
          code_verifier: login.oauth.verifier,
          resource: service.mcp,
        }).toString(),
      }),
      login.connection.name,
    );
    if (!body.access_token) {
      throw new ProviderError(`${login.connection.name} sent no token.`);
    }
    await storeToken(login.ws, login.connection.id, {
      access: body.access_token,
      refresh: body.refresh_token,
      expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : jwtExpiry(body.access_token),
      clientId: login.oauth.clientId,
      tokenEndpoint: login.oauth.tokenEndpoint,
    }, true);
    login.state = "done";
  } catch (error) {
    login.state = "error";
    login.error = error instanceof Error ? error.message : "The login failed.";
  }
  return login;
}

export function loginStatus(id: string, ws: Workspace): AiLoginStatus | null {
  const login = logins.get(id);
  if (login?.ws.key !== ws.key) {
    return null;
  }
  return { state: login.state, ...(login.error ? { error: login.error } : {}) };
}

/* -------------------------------------------------------------------- */
/* Reading answers                                                      */
/* -------------------------------------------------------------------- */

/** First string value whose key matches, searching nested objects and arrays. */
function findString(value: unknown, key: RegExp): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, key);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [name, entry] of Object.entries(value)) {
      if (key.test(name) && (typeof entry === "string" || typeof entry === "number") && String(entry) !== "") {
        return String(entry);
      }
    }
    for (const entry of Object.values(value)) {
      const found = findString(entry, key);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** Every http(s) address in an answer, with the key it was under. */
function findUrls(value: unknown, key = ""): { key: string; url: string }[] {
  if (typeof value === "string") {
    return [...value.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((match) => ({ key, url: match[0] }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => findUrls(item, key));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([name, entry]) => findUrls(entry, name));
  }
  return [];
}

/** The picture in a finished task: unwatermarked first, never a thumbnail or cover. */
export function pickImageUrl(value: unknown): string | undefined {
  const urls = findUrls(value).filter(({ key, url }) => !/cover|thumb|preview|avatar|icon/i.test(key) && !/(\.mp4|\.mov|\.webm)(\?|$)/i.test(url));
  const unmarked = urls.find(({ key }) => /without_?watermark|no_?watermark|raw|origin/i.test(key));
  const imageLike = urls.find(({ url }) => /\.(png|jpe?g|webp)(\?|$)/i.test(url));
  const underUrl = urls.find(({ key }) => /url|uri|artifact|image|output|resource/i.test(key));
  return (unmarked ?? imageLike ?? underUrl)?.url;
}

export type TaskState = { state: "running" } | { state: "done"; url: string } | { state: "error"; message: string };

/** Reads a task answer of unknown shape: a status word plus, when finished, a picture address. */
export function taskState(answer: unknown, service: string): TaskState {
  const status = (findString(answer, /^(status|state|task_?status)$/i) ?? "").toLowerCase();
  if (/fail|error|cancel|reject|block|moderat|denied/.test(status)) {
    const reason = findString(answer, /^(message|failure|failure_?reason|reason|error|error_?message|fail_?msg)$/i);
    return { state: "error", message: `${service} couldn't make the picture${reason ? `: ${reason.slice(0, 200)}` : ` (${status})`}.` };
  }
  const url = pickImageUrl(answer);
  if (url && (!status || /succe|complete|finish|done|ok/.test(status))) {
    return { state: "done", url };
  }
  return { state: "running" };
}

export function nearestRatio(width: number, height: number, ratios: readonly string[]): string {
  const wanted = Math.log(width / height);
  let best = ratios[0] ?? "1:1";
  let distance = Infinity;
  for (const ratio of ratios) {
    const [w = 1, h = 1] = ratio.split(":").map(Number);
    const d = Math.abs(Math.log(w / h) - wanted);
    if (d < distance) {
      best = ratio;
      distance = d;
    }
  }
  return best;
}

async function download(url: string, service: string): Promise<GeneratedImage> {
  const response = await send(url, { timeoutMs: 120_000 });
  if (!response.ok) {
    throw new ProviderError(`${service} made the picture but it couldn't be downloaded (${String(response.status)}).`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith("text/") || type.includes("json") || type.includes("svg")) {
    throw new ProviderError(`${service} sent something that isn't a picture (${type}).`);
  }
  const extension = type.includes("jpeg") || /\.jpe?g(\?|$)/i.test(url) ? ".jpg" : type.includes("webp") || /\.webp(\?|$)/i.test(url) ? ".webp" : ".png";
  return { bytes: Buffer.from(await response.arrayBuffer()), extension };
}

async function poll(service: string, check: () => Promise<TaskState>, minutes = 8): Promise<string> {
  const deadline = Date.now() + minutes * 60_000;
  await new Promise((resolve) => setTimeout(resolve, 4000));
  while (Date.now() < deadline) {
    const result = await check();
    if (result.state === "done") {
      return result.url;
    }
    if (result.state === "error") {
      throw new ProviderError(result.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new ProviderError(`${service} took longer than ${String(minutes)} minutes.`);
}

/* -------------------------------------------------------------------- */
/* MCP (Kling, Runway)                                                  */
/* -------------------------------------------------------------------- */

class AuthExpired extends Error {}

/** A short MCP session over streamable HTTP: initialize, then tool calls. */
class McpSession {
  private sessionId: string | undefined;
  private protocol: string | undefined;
  private nextId = 1;

  constructor(private readonly url: string, private readonly token: string, private readonly service: string) {}

  private async post(message: Record<string, unknown>, expectAnswer: boolean): Promise<unknown> {
    const response = await send(this.url, {
      method: "POST",
      timeoutMs: 120_000,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...(this.protocol ? { "MCP-Protocol-Version": this.protocol } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });
    if (response.status === 401) {
      await response.text();
      throw new AuthExpired();
    }
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(`${this.service} answered ${String(response.status)}: ${text.slice(0, 200)}`);
    }
    if (!expectAnswer) {
      return undefined;
    }
    const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean)
      : [text];
    for (const raw of messages) {
      let parsed: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.id !== message.id) {
        continue;
      }
      if (parsed.error) {
        throw new ProviderError(`${this.service}: ${parsed.error.message ?? "the request failed"}`);
      }
      return parsed.result;
    }
    throw new ProviderError(`${this.service} sent no answer.`);
  }

  async open(): Promise<void> {
    const result = await this.post({
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "MyCanvas", version: "1.0" } },
    }, true) as { protocolVersion?: string };
    this.protocol = result.protocolVersion;
    await this.post({ method: "notifications/initialized" }, false);
  }

  /** Calls a tool; its JSON answer when it gives one, else its text. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.post({ id: this.nextId++, method: "tools/call", params: { name, arguments: args } }, true) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    if (result.isError) {
      throw new ProviderError(`${this.service}: ${text.slice(0, 300) || "the request failed"}`);
    }
    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

/** Runs `work` in an MCP session, renewing the login once if the service says it expired. */
async function withMcp<T>(ws: Workspace, connection: AiConnection, raw: string | undefined, work: (session: McpSession) => Promise<T>): Promise<T> {
  const service = OAUTH[connection.kind as "kling" | "runway"];
  const attempt = async (force: boolean) => {
    const session = new McpSession(service.mcp, await accessToken(ws, connection, raw, force), connection.name);
    await session.open();
    return work(session);
  };
  try {
    return await attempt(false);
  } catch (error) {
    if (!(error instanceof AuthExpired)) {
      throw error;
    }
    try {
      return await attempt(true);
    } catch (again) {
      if (again instanceof AuthExpired) {
        throw new ProviderError(`${connection.name}: the login has expired. Log in again in AI settings.`);
      }
      throw again;
    }
  }
}

/** Ratios every Kling image model accepts. */
const KLING_RATIOS = ["9:16", "2:3", "3:4", "1:1", "4:3", "3:2", "16:9", "21:9"];
/** Ratios most Runway image models accept (nano-banana-pro has the fewest). */
const RUNWAY_RATIOS = ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"];
/** Runway models that need a source image or don't make a raster picture. */
const RUNWAY_SKIP = /vector|precise-edit|fibo-edit|image-turbo/;

/* -------------------------------------------------------------------- */
/* PixVerse                                                             */
/* -------------------------------------------------------------------- */

interface PixverseAnswer {
  ErrCode?: number;
  ErrMsg?: string;
  Resp?: unknown;
}

async function pixverseRaw(endpoint: string, token: string | null, body?: Record<string, unknown>): Promise<PixverseAnswer> {
  const response = await send(`${PIXVERSE}/${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: { "Accept": "application/json", "Accept-Language": "en-US", ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Token: token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return readJson<PixverseAnswer>(response, "PixVerse");
}

async function pixverseCall<T>(connection: AiConnection, endpoint: string, token: string | null, body?: Record<string, unknown>): Promise<T> {
  const answer = await pixverseRaw(endpoint, token, body);
  if (answer.ErrCode === 10001 || answer.ErrCode === 10004) {
    throw new ProviderError(`${connection.name}: the login has expired. Log in again in AI settings.`);
  }
  if (answer.ErrCode !== 0) {
    throw new ProviderError(`${connection.name}: ${answer.ErrMsg ?? `error ${String(answer.ErrCode)}`}`);
  }
  return (answer.Resp ?? {}) as T;
}

/** PixVerse image models: default output size and the ratios each accepts (from the PixVerse CLI's capabilities). */
const WIDE = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "21:9"];
const PORTRAIT = ["1:1", "16:9", "9:16", "4:3", "3:4", "5:4", "4:5", "3:2", "2:3", "21:9"];
const KLING_PX = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"];
const PIXVERSE_MODELS: { id: string; label: string; quality: string; ratios: string[] }[] = [
  { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", quality: "1080p", ratios: WIDE },
  { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", quality: "1080p", ratios: WIDE },
  { id: "gpt-image-2.0", label: "GPT Image 2", quality: "1080p", ratios: WIDE },
  { id: "gemini-3.1-flash", label: "Nano Banana 2", quality: "1080p", ratios: PORTRAIT },
  { id: "gemini-3.1-flash-lite", label: "Nano Banana 2 Lite", quality: "1080p", ratios: PORTRAIT },
  { id: "gemini-3.0", label: "Nano Banana Pro", quality: "1080p", ratios: PORTRAIT },
  { id: "gemini-2.5-flash", label: "Nano Banana", quality: "1080p", ratios: PORTRAIT },
  { id: "qwen-image", label: "Qwen Image", quality: "1080p", ratios: PORTRAIT },
  { id: "seedream-5.0-pro", label: "Seedream 5.0 Pro", quality: "1080p", ratios: PORTRAIT },
  { id: "seedream-5.0-lite", label: "Seedream 5.0 Lite", quality: "1440p", ratios: PORTRAIT },
  { id: "seedream-4.5", label: "Seedream 4.5", quality: "1440p", ratios: PORTRAIT },
  { id: "seedream-4.0", label: "Seedream 4.0", quality: "1080p", ratios: PORTRAIT },
  { id: "kling-image-o3", label: "Kling Image O3", quality: "1080p", ratios: KLING_PX },
  { id: "kling-image-v3", label: "Kling Image 3", quality: "1080p", ratios: KLING_PX },
];

/* -------------------------------------------------------------------- */
/* What the routes call                                                 */
/* -------------------------------------------------------------------- */

export async function accountModels(ws: Workspace, connection: AiConnection, raw: string | undefined): Promise<AiModelInfo[]> {
  switch (connection.kind) {
    case "kling":
      return withMcp(ws, connection, raw, async (session) => {
        const answer = await session.call("who_am_i", { tools: ["text_to_image"] }) as {
          availableModels?: { text_to_image?: { defaultModel?: string; models?: { model: string; alias?: string }[] } };
        };
        const tool = answer.availableModels?.text_to_image;
        const models = [...(tool?.models ?? [])].sort((a, b) => Number(b.model === tool?.defaultModel) - Number(a.model === tool?.defaultModel));
        return models.map((model) => ({ id: model.model, label: model.alias?.split(",")[0]?.trim() ?? model.model, kinds: ["image"] }));
      });
    case "runway":
      return withMcp(ws, connection, raw, async (session) => {
        const answer = await session.call("whoami", { rationale: "List the image models this workspace can run, for MyCanvas's AI settings." }) as { availableImageModels?: string[] };
        return (answer.availableImageModels ?? []).filter((id) => !RUNWAY_SKIP.test(id)).map((id) => ({ id, kinds: ["image"] }));
      });
    case "pixverse":
      // Checks the login too.
      await accountCredits(ws, connection, raw);
      return PIXVERSE_MODELS.map((model) => ({ id: model.id, label: model.label, kinds: ["image"] }));
    default:
      throw new AiSettingsError(`${connection.name} isn't an account connection.`);
  }
}

export async function accountCredits(ws: Workspace, connection: AiConnection, raw: string | undefined): Promise<AiCredits> {
  switch (connection.kind) {
    case "kling":
      return withMcp(ws, connection, raw, async (session) => {
        const answer = await session.call("query_membership_and_credits", {}) as { availableRemainCredits?: number; membershipTypeDescription?: string };
        return { credits: typeof answer.availableRemainCredits === "number" ? answer.availableRemainCredits : null, plan: answer.membershipTypeDescription };
      });
    case "runway":
      return withMcp(ws, connection, raw, async (session) => {
        const answer = await session.call("whoami", { rationale: "Show the remaining Runway credits in MyCanvas's AI settings." }) as {
          credits?: { total?: number; unlimited?: boolean };
          team?: { name?: string };
        };
        return { credits: answer.credits?.unlimited ? null : answer.credits?.total ?? null, plan: answer.credits?.unlimited ? "Unlimited" : answer.team?.name };
      });
    case "pixverse": {
      const token = await accessToken(ws, connection, raw);
      const answer = await pixverseCall<{ credit_daily?: number; credit_monthly?: number; credit_package?: number }>(connection, "user/credits", token);
      const parts = [answer.credit_daily, answer.credit_monthly, answer.credit_package].filter((value): value is number => typeof value === "number");
      return { credits: parts.length ? parts.reduce((sum, value) => sum + value, 0) : null };
    }
    default:
      throw new AiSettingsError(`${connection.name} isn't an account connection.`);
  }
}

export async function accountImage(ws: Workspace, connection: AiConnection, raw: string | undefined, model: string, request: ImageRequest): Promise<GeneratedImage> {
  switch (connection.kind) {
    case "kling": {
      const url = await withMcp(ws, connection, raw, async (session) => {
        const trace = randomUUID();
        const started = await session.call("text_to_image", {
          model: model || "kling-image-v3_0_omni",
          arguments: [
            { name: "prompt", value: request.prompt },
            { name: "aspect_ratio", value: nearestRatio(request.width, request.height, KLING_RATIOS) },
            { name: "img_resolution", value: "1k" },
          ],
          rationale: "A picture for a page the person is designing in MyCanvas, asked for from its page panel or design builder.",
          taskTraceId: trace,
        });
        const id = findString(started, /^generation_?id$/i) ?? findString(started, /^(task_?id|id)$/i);
        if (!id) {
          throw new ProviderError(`Kling didn't start the picture: ${JSON.stringify(started).slice(0, 200)}`);
        }
        return poll("Kling", async () => taskState(await session.call("query_tasks", { generationId: id, taskTraceId: trace }), "Kling"));
      });
      return download(url, "Kling");
    }
    case "runway": {
      const url = await withMcp(ws, connection, raw, async (session) => {
        const started = await session.call("generate_image", {
          promptText: request.prompt,
          model: model || "nano-banana-2.1",
          ratio: nearestRatio(request.width, request.height, RUNWAY_RATIOS),
          imageSize: "1K",
          count: 1,
          // "Make another picture" with the same words is a new picture, not the earlier one.
          confirmRepeat: true,
          rationale: "A picture for a page the person is designing in MyCanvas, asked for from its page panel or design builder.",
        });
        const id = findString(started, /^(task_?id|taskIds?|id)$/i) ??
          (typeof started === "string" ? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(started)?.[0] : undefined);
        if (!id) {
          throw new ProviderError(`Runway didn't start the picture: ${JSON.stringify(started).slice(0, 200)}`);
        }
        return poll("Runway", async () => taskState(await session.call("get_task", { id, rationale: "Check whether the MyCanvas picture is ready." }), "Runway"));
      });
      return download(url, "Runway");
    }
    case "pixverse": {
      const token = await accessToken(ws, connection, raw);
      const spec = PIXVERSE_MODELS.find((entry) => entry.id === model) ?? PIXVERSE_MODELS[0];
      const started = await pixverseCall<unknown>(connection, "image/t2i", token, {
        prompt: request.prompt,
        model: spec?.id ?? model,
        quality: spec?.quality ?? "1080p",
        create_count: 1,
        aspect_ratio: nearestRatio(request.width, request.height, spec?.ratios ?? WIDE),
        seed: randomInt(1, 2 ** 31),
      });
      const id = findString(started, /^image_?ids?$/i);
      if (!id) {
        throw new ProviderError(`PixVerse didn't start the picture: ${JSON.stringify(started).slice(0, 200)}`);
      }
      const url = await poll("PixVerse", async () => {
        const detail = await pixverseCall<{ image_status?: number; image_url?: string }>(connection, "image/detail", token, { image_id: Number(id) || id });
        if (detail.image_status === 1 && detail.image_url) {
          return { state: "done", url: detail.image_url };
        }
        if (detail.image_status === 7) {
          return { state: "error", message: "PixVerse didn't approve this prompt (content moderation)." };
        }
        if (detail.image_status === 8) {
          return { state: "error", message: "PixVerse couldn't make the picture." };
        }
        return { state: "running" };
      });
      return download(url, "PixVerse");
    }
    default:
      throw new AiSettingsError(`${connection.name} isn't an account connection.`);
  }
}
