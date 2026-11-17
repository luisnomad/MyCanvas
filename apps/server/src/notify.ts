import { decryptSecret, encryptSecret } from "./secrets";
import { type Workspace, readJsonFile, writeJsonFile } from "./storage";

/*
 * Tells the owner of a shared design when a customer answers on the link:
 * approves, asks for changes, or downloads the approved PDF.
 *
 * Each person sets their own channels in the editor (user menu →
 * Notifications), stored per workspace in data/users/<key>/notifications.json:
 *   Telegram: bot token (from @BotFather) + chat ID
 *   Webhook:  URL (JSON POST; ntfy, relays…), optional topic and bearer token
 * The bot token, webhook URL and webhook token are encrypted (secrets.ts)
 * and only ever go back to the browser masked. No settings, no messages.
 *
 * MYCANVAS_EDITOR_URL is where the editor runs, for the link in the message
 * (default https://canva.local).
 *
 * Fire and forget: each channel gets a few seconds, failures are logged
 * without secrets, and nothing here can fail the customer's request.
 */

export type NoticeKind = "approved" | "changes" | "downloaded" | "opened" | "test";

/** One open of a share link, for the "link opened" message. */
export interface OpenInfo {
  at: string;
  newVisitor: boolean;
  device: string;
  browser: string;
  os: string;
  ip: string | null;
  country: string | null;
}

export interface ShareNotice {
  kind: NoticeKind;
  designId: string;
  designName: string;
  reviewer: string;
  revision: number;
  comment?: string;
  sha256?: string;
  /** opened: the opens this message reports (more than one when held back by the 10-minute limit). */
  opens?: OpenInfo[];
}

/** Decrypted settings, server-side only. */
export interface NotifyConfig {
  telegram?: { botToken: string; chatId: string };
  webhook?: { url: string; topic?: string; token?: string };
  /** Send "link opened" messages (default true). */
  notifyOnOpen?: boolean;
}

/** What is stored on disk. */
interface StoredSettings {
  telegram?: { botToken?: string; chatId?: string };
  webhook?: { url?: string; topic?: string; token?: string };
  notifyOnOpen?: boolean;
}

/** What the browser and the agent see: secrets masked, never in full. */
export interface MaskedSettings {
  telegram: { botToken: string | null; chatId: string };
  webhook: { url: string | null; topic: string; token: string | null };
  /** Send a message when a share link is opened (default on). */
  notifyOnOpen: boolean;
  /** At least one channel is complete. */
  configured: boolean;
}

/** A change: undefined keeps a field, "" or null clears it, a string replaces it. */
export interface SettingsChange {
  telegram?: { botToken?: string | null; chatId?: string | null };
  webhook?: { url?: string | null; topic?: string | null; token?: string | null };
  notifyOnOpen?: boolean;
}

const TIMEOUT_MS = 5000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Tests: replace the network (null restores fetch). */
export function setNotifyFetch(replacement: FetchLike | null): void {
  fetchImpl = replacement ?? ((url, init) => fetch(url, init));
}

// ------------------------------------------------------------- settings

function context(ws: Workspace, field: string): string {
  return `notify:${ws.key}:${field}`;
}

async function readStored(ws: Workspace): Promise<StoredSettings> {
  return (await readJsonFile<StoredSettings>(ws.notificationsFile)) ?? {};
}

async function open(ws: Workspace, sealed: string | undefined, field: string): Promise<string> {
  if (!sealed) {
    return "";
  }
  try {
    return await decryptSecret(sealed, context(ws, field));
  } catch {
    // Unreadable (e.g. the server key changed): treated as not set.
    return "";
  }
}

/** The owner's channels, decrypted (server-side only). */
export async function notifyConfig(ws: Workspace): Promise<NotifyConfig> {
  const stored = await readStored(ws);
  const config: NotifyConfig = { notifyOnOpen: stored.notifyOnOpen !== false };
  const botToken = await open(ws, stored.telegram?.botToken, "telegram.botToken");
  const chatId = stored.telegram?.chatId ?? "";
  if (botToken && chatId) {
    config.telegram = { botToken, chatId };
  }
  const url = await open(ws, stored.webhook?.url, "webhook.url");
  if (url) {
    const token = await open(ws, stored.webhook?.token, "webhook.token");
    config.webhook = { url, ...(stored.webhook?.topic ? { topic: stored.webhook.topic } : {}), ...(token ? { token } : {}) };
  }
  return config;
}

/** "••••1234": enough to recognise a secret, never enough to use it. */
export function mask(secret: string): string {
  return secret.length <= 8 ? "••••" : `••••${secret.slice(-4)}`;
}

export async function maskedSettings(ws: Workspace): Promise<MaskedSettings> {
  const stored = await readStored(ws);
  const botToken = await open(ws, stored.telegram?.botToken, "telegram.botToken");
  const url = await open(ws, stored.webhook?.url, "webhook.url");
  const token = await open(ws, stored.webhook?.token, "webhook.token");
  const chatId = stored.telegram?.chatId ?? "";
  return {
    telegram: { botToken: botToken ? mask(botToken) : null, chatId },
    webhook: { url: url ? mask(url) : null, topic: stored.webhook?.topic ?? "", token: token ? mask(token) : null },
    notifyOnOpen: stored.notifyOnOpen !== false,
    configured: Boolean(botToken && chatId) || Boolean(url),
  };
}

export class SettingsError extends Error {}

function cleanText(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SettingsError(`${field} must be a string or null`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new SettingsError(`${field} is too long`);
  }
  return text;
}

/** Reads a PUT body; throws SettingsError with a message for the user. */
export function parseSettingsChange(body: Record<string, unknown>): SettingsChange {
  const telegram = (body.telegram ?? {}) as Record<string, unknown>;
  const webhook = (body.webhook ?? {}) as Record<string, unknown>;
  if (typeof telegram !== "object" || typeof webhook !== "object") {
    throw new SettingsError("telegram and webhook must be objects");
  }
  const botToken = cleanText(telegram.botToken, "telegram.botToken", 200);
  if (botToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new SettingsError("That doesn't look like a Telegram bot token (123456789:ABC…)");
  }
  const chatId = cleanText(telegram.chatId, "telegram.chatId", 64);
  if (chatId && !/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(chatId)) {
    throw new SettingsError("The chat ID is a number (e.g. 123456789, or -100… for a group) or @channelname");
  }
  const url = cleanText(webhook.url, "webhook.url", 2000);
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SettingsError("The webhook URL isn't a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new SettingsError("The webhook URL must start with https://");
    }
  }
  const notifyOnOpen = body.notifyOnOpen;
  if (notifyOnOpen !== undefined && typeof notifyOnOpen !== "boolean") {
    throw new SettingsError("notifyOnOpen must be true or false");
  }
  return {
    telegram: { botToken, chatId },
    webhook: { url, topic: cleanText(webhook.topic, "webhook.topic", 200), token: cleanText(webhook.token, "webhook.token", 500) },
    ...(notifyOnOpen === undefined ? {} : { notifyOnOpen }),
  };
}

async function seal(ws: Workspace, current: string | undefined, next: string | null | undefined, field: string): Promise<string | undefined> {
  if (next === undefined) {
    return current;
  }
  return next ? encryptSecret(next, context(ws, field)) : undefined;
}

function plain(current: string | undefined, next: string | null | undefined): string | undefined {
  if (next === undefined) {
    return current;
  }
  return next ?? undefined;
}

/** Applies a change and returns the masked result. */
export async function saveSettings(ws: Workspace, change: SettingsChange): Promise<MaskedSettings> {
  const stored = await readStored(ws);
  const next: StoredSettings = {
    telegram: {
      botToken: await seal(ws, stored.telegram?.botToken, change.telegram?.botToken, "telegram.botToken"),
      chatId: plain(stored.telegram?.chatId, change.telegram?.chatId),
    },
    webhook: {
      url: await seal(ws, stored.webhook?.url, change.webhook?.url, "webhook.url"),
      topic: plain(stored.webhook?.topic, change.webhook?.topic),
      token: await seal(ws, stored.webhook?.token, change.webhook?.token, "webhook.token"),
    },
    notifyOnOpen: change.notifyOnOpen ?? stored.notifyOnOpen,
  };
  await writeJsonFile(ws.notificationsFile, JSON.parse(JSON.stringify(next)) as StoredSettings);
  return maskedSettings(ws);
}

// ------------------------------------------------------------- sending

export function editorUrl(designId: string, source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.MYCANVAS_EDITOR_URL?.trim() ?? "";
  const base = configured === "" ? "https://canva.local" : configured;
  return `${base.replace(/\/+$/, "")}/#/edit/${encodeURIComponent(designId)}`;
}

/** The message, in plain text (no Markdown, so names never need escaping). */
export function noticeMessage(notice: ShareNotice, source: NodeJS.ProcessEnv = process.env): { title: string; text: string; editorUrl: string } {
  if (notice.kind === "test") {
    const title = "MyCanvas: test notification";
    return { title, text: `${title}\nShare-link notifications reach you here.`, editorUrl: editorUrl("", source).replace(/\/#\/edit\/$/, "") };
  }
  if (notice.kind === "opened") {
    return openedMessage(notice, source);
  }
  const what = notice.kind === "approved"
    ? "approved"
    : notice.kind === "changes" ? "requested changes on" : "downloaded the approved PDF of";
  const title = `MyCanvas: ${notice.reviewer} ${what} "${notice.designName}"`;
  const url = editorUrl(notice.designId, source);
  const lines = [title, `Revision ${String(notice.revision)}`];
  if (notice.comment) {
    lines.push(`Comment: ${notice.comment.slice(0, 1000)}`);
  }
  if (notice.sha256) {
    lines.push(`PDF SHA-256: ${notice.sha256}`);
  }
  lines.push(url);
  return { title, text: lines.join("\n"), editorUrl: url };
}

const DEVICE_LABEL: Record<string, string> = { mobile: "phone", tablet: "tablet", desktop: "computer" };

function openLine(open: OpenInfo): string {
  const where = [open.country, open.ip].filter(Boolean).join(" ");
  return [
    open.newVisitor ? "New visitor" : "Returning visitor",
    DEVICE_LABEL[open.device] ?? open.device,
    open.os ? `${open.browser} on ${open.os}` : open.browser,
    where,
  ].filter(Boolean).join(" · ");
}

function openedMessage(notice: ShareNotice, source: NodeJS.ProcessEnv): { title: string; text: string; editorUrl: string } {
  const opens = notice.opens ?? [];
  const title = opens.length > 1
    ? `MyCanvas: "${notice.designName}" was opened ${String(opens.length)} times`
    : `MyCanvas: "${notice.designName}" was opened`;
  const url = editorUrl(notice.designId, source);
  const lines = [title, ...opens.slice(0, 10).map(openLine)];
  if (opens.length > 10) {
    lines.push(`…and ${String(opens.length - 10)} more`);
  }
  lines.push(url);
  return { title, text: lines.join("\n"), editorUrl: url };
}

interface Transport {
  name: "telegram" | "webhook";
  send: (notice: ShareNotice, message: { title: string; text: string; editorUrl: string }, signal: AbortSignal) => Promise<void>;
}

async function expectOk(res: Response): Promise<void> {
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${String(res.status)} ${body}`);
  }
}

/** The channels a config describes. */
export function transportsFor(config: NotifyConfig, send: FetchLike = fetchImpl): Transport[] {
  const transports: Transport[] = [];
  const { telegram, webhook } = config;
  if (telegram) {
    transports.push({
      name: "telegram",
      send: async (_notice, message, signal) => {
        await expectOk(await send(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: telegram.chatId, text: message.text, disable_web_page_preview: true }),
          signal,
        }));
      },
    });
  }
  if (webhook) {
    transports.push({
      name: "webhook",
      send: async (notice, message, signal) => {
        await expectOk(await send(webhook.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(webhook.token ? { authorization: `Bearer ${webhook.token}` } : {}) },
          body: JSON.stringify({
            ...(webhook.topic ? { topic: webhook.topic } : {}),
            event: `share.${notice.kind}`,
            title: message.title,
            message: message.text,
            click: message.editorUrl,
            design: { id: notice.designId, name: notice.designName },
            reviewer: notice.reviewer,
            revision: notice.revision,
            comment: notice.comment ?? null,
            sha256: notice.sha256 ?? null,
            ...(notice.opens ? { opens: notice.opens } : {}),
            editorUrl: message.editorUrl,
            at: new Date().toISOString(),
          }),
          signal,
        }));
      },
    });
  }
  return transports;
}

/** Removes the config's secrets from a message (logs and test results). */
export function redact(text: string, config: NotifyConfig): string {
  const secrets = [config.telegram?.botToken, config.webhook?.url, config.webhook?.token].filter((s): s is string => Boolean(s));
  return secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

export interface ChannelResult { channel: "telegram" | "webhook"; ok: boolean; error?: string }

/** Sends on every channel of the config; never throws. */
export async function sendAll(config: NotifyConfig, notice: ShareNotice): Promise<ChannelResult[]> {
  const transports = transportsFor(config);
  const message = noticeMessage(notice);
  return Promise.all(transports.map(async (transport): Promise<ChannelResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
    timer.unref();
    try {
      await transport.send(notice, message, controller.signal);
      return { channel: transport.name, ok: true };
    } catch (error) {
      const reason = controller.signal.aborted ? `timed out after ${String(TIMEOUT_MS / 1000)} s` : error instanceof Error ? error.message : String(error);
      return { channel: transport.name, ok: false, error: redact(reason, config) };
    } finally {
      clearTimeout(timer);
    }
  }));
}

/**
 * Tells the design's owner (their own settings). Never throws and never
 * waits longer than the timeout; callers don't await it.
 */
export async function notify(owner: Workspace, notice: ShareNotice): Promise<void> {
  try {
    const config = await notifyConfig(owner);
    if (notice.kind === "opened" && config.notifyOnOpen === false) {
      return;
    }
    for (const result of await sendAll(config, notice)) {
      if (!result.ok) {
        console.warn(`notify (${result.channel}) failed: ${result.error ?? ""}`);
      }
    }
  } catch (error) {
    console.warn("notify failed:", error instanceof Error ? error.message : String(error));
  }
}
