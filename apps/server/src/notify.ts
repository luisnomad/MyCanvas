/*
 * Tells Luis when a customer answers on a share link: approves, asks for
 * changes, or downloads the approved PDF. Configured with env vars (see
 * docs/AGENT_API.md, "Notifications"):
 *
 *   NOTIFY_TELEGRAM_BOT_TOKEN + NOTIFY_TELEGRAM_CHAT_ID   Telegram bot message
 *   NOTIFY_WEBHOOK_URL                                     JSON POST (ntfy, Slack-style relays, …)
 *     NOTIFY_WEBHOOK_TOPIC   adds "topic" to the JSON (ntfy's JSON publishing at the server root)
 *     NOTIFY_WEBHOOK_TOKEN   sent as "Authorization: Bearer …"
 *   MYCANVAS_EDITOR_URL     where the editor runs, for the link in the message (default https://canva.local)
 *
 * Fire and forget: each channel gets a few seconds, failures are logged
 * without secrets, and nothing here can fail the customer's request.
 */

export type NoticeKind = "approved" | "changes" | "downloaded";

export interface ShareNotice {
  kind: NoticeKind;
  designId: string;
  designName: string;
  reviewer: string;
  revision: number;
  comment?: string;
  sha256?: string;
}

export interface NotifyTransport {
  name: string;
  send: (notice: ShareNotice, message: { title: string; text: string; editorUrl: string }, signal: AbortSignal) => Promise<void>;
}

const TIMEOUT_MS = 5000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function env(name: string, source: NodeJS.ProcessEnv): string {
  return source[name]?.trim() ?? "";
}

export function editorUrl(designId: string, source: NodeJS.ProcessEnv = process.env): string {
  const base = env("MYCANVAS_EDITOR_URL", source) || "https://canva.local";
  return `${base.replace(/\/+$/, "")}/#/edit/${encodeURIComponent(designId)}`;
}

/** The message, in plain text (no Markdown, so names never need escaping). */
export function noticeMessage(notice: ShareNotice, source: NodeJS.ProcessEnv = process.env): { title: string; text: string; editorUrl: string } {
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

async function expectOk(res: Response): Promise<void> {
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${String(res.status)} ${body}`);
  }
}

/** The channels configured in the environment. */
export function transportsFromEnv(source: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): NotifyTransport[] {
  const transports: NotifyTransport[] = [];
  const botToken = env("NOTIFY_TELEGRAM_BOT_TOKEN", source);
  const chatId = env("NOTIFY_TELEGRAM_CHAT_ID", source);
  if (botToken && chatId) {
    transports.push({
      name: "telegram",
      send: async (_notice, message, signal) => {
        await expectOk(await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message.text, disable_web_page_preview: true }),
          signal,
        }));
      },
    });
  }
  const webhook = env("NOTIFY_WEBHOOK_URL", source);
  if (webhook) {
    const topic = env("NOTIFY_WEBHOOK_TOPIC", source);
    const token = env("NOTIFY_WEBHOOK_TOKEN", source);
    transports.push({
      name: "webhook",
      send: async (notice, message, signal) => {
        await expectOk(await fetchImpl(webhook, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({
            ...(topic ? { topic } : {}),
            event: `share.${notice.kind}`,
            title: message.title,
            message: message.text,
            click: message.editorUrl,
            design: { id: notice.designId, name: notice.designName },
            reviewer: notice.reviewer,
            revision: notice.revision,
            comment: notice.comment ?? null,
            sha256: notice.sha256 ?? null,
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

/** Secrets that must never reach the log. */
function secrets(source: NodeJS.ProcessEnv): string[] {
  return ["NOTIFY_TELEGRAM_BOT_TOKEN", "NOTIFY_WEBHOOK_URL", "NOTIFY_WEBHOOK_TOKEN"].map((name) => env(name, source)).filter(Boolean);
}

export function redact(text: string, source: NodeJS.ProcessEnv = process.env): string {
  return secrets(source).reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

let override: NotifyTransport[] | null = null;

/** Tests: replace the channels (null goes back to the environment). */
export function setNotifyTransports(transports: NotifyTransport[] | null): void {
  override = transports;
}

/**
 * Sends the notice on every configured channel. Never throws and never
 * waits longer than the timeout; callers don't await it.
 */
export async function notify(notice: ShareNotice): Promise<void> {
  const transports = override ?? transportsFromEnv();
  if (transports.length === 0) {
    return;
  }
  const message = noticeMessage(notice);
  await Promise.all(transports.map(async (transport) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
    timer.unref();
    try {
      await transport.send(notice, message, controller.signal);
    } catch (error) {
      const reason = controller.signal.aborted ? `timed out after ${String(TIMEOUT_MS / 1000)} s` : error instanceof Error ? error.message : String(error);
      console.warn(`notify (${transport.name}) failed: ${redact(reason)}`);
    } finally {
      clearTimeout(timer);
    }
  }));
}
