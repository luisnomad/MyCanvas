import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type RequestOrigin, type ShareProof, readProofs } from "./share-proofs";
import { type ShareRecord } from "./shares";
import { dataDir } from "./storage";

/*
 * Share activity: who opened a share link, when, from which device.
 *
 * An append-only log (data/share-activity.jsonl, one JSON object per line)
 * next to the proof log (share-proofs.jsonl, approvals and downloads). Like
 * that one it is never rewritten and outlives the link. The editor and the
 * agent read one merged timeline per design (activityFor).
 *
 * Lines:
 *   opened     a visitor's page loaded the design (a new session)
 *   view       the same visitor reloaded within the session (30 min): no new open
 *   page       a page first seen in a session (folded into its open as pagesViewed)
 *   pin-failed a wrong PIN
 *   preview    a link-preview bot (WhatsApp, Slack, Telegram, iMessage, Gmail…)
 *   changes    a change request (approvals and downloads live in the proof log)
 *
 * `audience` says who it was: "visitor", "owner" (the design's owner signed in
 * to the editor, or the agent token) or "bot". Owner and bot lines never count
 * as opens and never notify.
 *
 * Visitors are told on the page that opens, approvals and downloads are
 * recorded (date, IP, device) for the design's owner. Raw IPs stay in these
 * logs and in the owner's own notifications.
 */

export type ActivityKind = "opened" | "view" | "page" | "pin-failed" | "preview" | "changes";
export type Audience = "visitor" | "owner" | "bot";
export type DeviceType = "mobile" | "tablet" | "desktop" | "bot";

export interface ClientInfo {
  browser: string;
  os: string;
  device: DeviceType;
}

export interface ActivityLine extends RequestOrigin, ClientInfo {
  id: string;
  at: string;
  kind: ActivityKind;
  audience: Audience;
  token: string;
  /** Owner's identity; filters the log per workspace, never shown to anyone else. */
  owner: string;
  designId: string;
  revision: number;
  /** The page's random first-party id (localStorage), when it sent one. */
  visitorId: string | null;
  /** The open this line belongs to (opened, view, page). */
  sessionId?: string;
  /** Cloudflare's CF-IPCountry, when present. */
  country: string | null;
  /** "390x844" from the page, when sent. */
  screen?: string;
  /** page: the page index seen. */
  page?: number;
  /** changes: who and what. */
  name?: string;
  comment?: string;
  reviewId?: string;
}

/** A session lasts while the same visitor keeps coming back within this. */
export const SESSION_MS = 30 * 60_000;
/** Preview bots fetch a link again and again: one line per bot and IP per window. */
const PREVIEW_DEDUPE_MS = 30 * 60_000;

function activityFile(): string {
  return path.join(dataDir, "share-activity.jsonl");
}

let cache: ActivityLine[] | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<ActivityLine[]> {
  if (cache) {
    return cache;
  }
  let text = "";
  try {
    text = await readFile(activityFile(), "utf8");
  } catch {
    // No activity yet.
  }
  const lines: ActivityLine[] = [];
  for (const line of text.split("\n")) {
    if (line.trim()) {
      try {
        lines.push(JSON.parse(line) as ActivityLine);
      } catch {
        // A line cut short by a crash; the rest still counts.
      }
    }
  }
  cache = lines;
  return lines;
}

/** Forgets the in-memory copy (tests use a fresh data dir). */
export function resetActivityCache(): void {
  cache = null;
}

/** One write at a time; `decide` sees the log as it is and returns the lines to add. */
function append<T>(decide: (lines: ActivityLine[]) => { add: ActivityLine[]; result: T }): Promise<T> {
  const run = queue.then(async () => {
    const lines = await load();
    const { add, result } = decide(lines);
    if (add.length > 0) {
      await mkdir(path.dirname(activityFile()), { recursive: true });
      await appendFile(activityFile(), add.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
      lines.push(...add);
    }
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

// ------------------------------------------------------------- clients

/** Link previewers, crawlers and scripts: never a person opening the link. */
const BOT_PATTERN = new RegExp([
  "bot\\b", "crawler", "spider", "preview", "headless", "facebookexternalhit", "facebot", "whatsapp", "slack",
  "telegram", "twitterbot", "linkedin", "discord", "skypeuripreview", "googleimageproxy", "google-pagerenderer",
  "feedfetcher", "applebot", "bingpreview", "embedly", "pinterest", "vkshare", "w3c_validator", "curl/", "wget/",
  "python-requests", "python-urllib", "go-http-client", "node-fetch", "axios/", "okhttp", "java/", "lighthouse",
  "^mozilla/5\\.0$", "^$",
].join("|"), "i");

export function isBotAgent(userAgent: string | null): boolean {
  return BOT_PATTERN.test(userAgent ?? "");
}

/** First match wins. */
const BROWSERS: [RegExp, string][] = [
  [/EdgA?\/|EdgiOS/, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/FxiOS|Firefox\//, "Firefox"],
  [/CriOS|Chrome\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
  [/(iPhone|iPad|iPod).*AppleWebKit/, "Safari (in-app)"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, "iOS"],
  [/iPad/, "iPadOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

const BOT_NAMES = /(WhatsApp|TelegramBot|Slackbot|Slack-ImgProxy|facebookexternalhit|Twitterbot|LinkedInBot|Discordbot|GoogleImageProxy|Googlebot|bingbot|Applebot|HeadlessChrome|curl|python-requests)/i;

function firstMatch(table: [RegExp, string][], ua: string): string {
  return table.find(([pattern]) => pattern.test(ua))?.[1] ?? "Other";
}

/** A small user-agent reading: browser, OS and device type. `hint` comes from the page (touch screen). */
export function parseUserAgent(userAgent: string | null, hint: { touch?: boolean } = {}): ClientInfo {
  const ua = userAgent ?? "";
  if (isBotAgent(ua)) {
    return { browser: BOT_NAMES.exec(ua)?.[1] ?? "Bot", os: "", device: "bot" };
  }
  // iPadOS Safari says "Macintosh"; only the touch screen gives it away.
  const ipad = ua.includes("iPad") || (ua.includes("Macintosh") && hint.touch === true);
  const os = ipad ? "iPadOS" : firstMatch(SYSTEMS, ua);
  let device: DeviceType = "desktop";
  const android = ua.includes("Android");
  if (ipad || ua.includes("Tablet") || (android && !ua.includes("Mobile"))) {
    device = "tablet";
  } else if (/iPhone|iPod|Mobile|Android/.test(ua)) {
    device = "mobile";
  }
  return { browser: firstMatch(BROWSERS, ua), os, device };
}

/** The anonymous key for counting devices: the page's visitor id, else IP + browser. */
export function visitorKey(line: Pick<ActivityLine, "visitorId" | "ip" | "userAgent">): string {
  return line.visitorId ?? `ip-${createHash("sha256").update(`${line.ip ?? ""}|${line.userAgent ?? ""}`).digest("hex").slice(0, 16)}`;
}

const VISITOR_PATTERN = /^[a-f0-9]{16,64}$/;

export function cleanVisitorId(value: unknown): string | null {
  return typeof value === "string" && VISITOR_PATTERN.test(value) ? value : null;
}

// ------------------------------------------------------------- recording

export interface EventInput {
  record: ShareRecord;
  revision: number;
  origin: RequestOrigin;
  country: string | null;
  audience: Audience;
  visitorId: string | null;
  screen?: string;
  touch?: boolean;
}

function baseLine(kind: ActivityKind, input: EventInput, now: number): ActivityLine {
  const client = parseUserAgent(input.origin.userAgent, { touch: input.touch });
  return {
    id: randomBytes(8).toString("hex"),
    at: new Date(now).toISOString(),
    kind,
    audience: input.audience,
    token: input.record.token,
    owner: input.record.email,
    designId: input.record.designId,
    revision: input.revision,
    visitorId: input.visitorId,
    ...input.origin,
    ...client,
    country: input.country,
    ...(input.screen ? { screen: input.screen } : {}),
  };
}

/** The latest open/view of this visitor on this link, if its session is still running. */
function liveSession(lines: ActivityLine[], token: string, key: string, now: number): ActivityLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.token !== token || (line.kind !== "opened" && line.kind !== "view") || visitorKey(line) !== key) {
      continue;
    }
    return now - Date.parse(line.at) < SESSION_MS ? line : null;
  }
  return null;
}

export interface OpenResult {
  /** A new session (what notifies); false for a reload in the same session, a bot or the owner. */
  opened: boolean;
  /** First open ever by this visitor on any of the design's links. */
  newVisitor: boolean;
  line: ActivityLine | null;
}

/**
 * The page loaded the design. A new session is an `opened` line; a reload by
 * the same visitor within SESSION_MS is a `view` line in that session.
 * Bots become a `preview` line (deduplicated).
 */
export function recordOpen(input: EventInput, now = Date.now()): Promise<OpenResult> {
  return append<OpenResult>((lines) => {
    if (input.audience === "bot") {
      const line = previewLine(lines, input, now);
      return { add: line ? [line] : [], result: { opened: false, newVisitor: false, line } };
    }
    const key = visitorKey({ visitorId: input.visitorId, ip: input.origin.ip, userAgent: input.origin.userAgent });
    const session = liveSession(lines, input.record.token, key, now);
    if (session) {
      const line: ActivityLine = { ...baseLine("view", input, now), sessionId: session.sessionId ?? session.id };
      return { add: [line], result: { opened: false, newVisitor: false, line } };
    }
    const line = baseLine("opened", input, now);
    line.sessionId = line.id;
    const seenBefore = lines.some((l) => l.owner === input.record.email && l.designId === input.record.designId && l.kind === "opened" && visitorKey(l) === key);
    return { add: [line], result: { opened: input.audience === "visitor", newVisitor: !seenBefore, line } };
  });
}

function previewLine(lines: ActivityLine[], input: EventInput, now: number): ActivityLine | null {
  const repeat = lines.some((l) =>
    l.kind === "preview" && l.token === input.record.token && l.userAgent === input.origin.userAgent &&
    l.ip === input.origin.ip && now - Date.parse(l.at) < PREVIEW_DEDUPE_MS);
  return repeat ? null : baseLine("preview", input, now);
}

/** A link preview fetched the page itself (no script ran). */
export function recordPreview(input: EventInput, now = Date.now()): Promise<ActivityLine | null> {
  return append((lines) => {
    const line = previewLine(lines, input, now);
    return { add: line ? [line] : [], result: line };
  });
}

/** A page seen for the first time in the visitor's current session. */
export function recordPage(input: EventInput & { page: number }, now = Date.now()): Promise<void> {
  return append((lines) => {
    const key = visitorKey({ visitorId: input.visitorId, ip: input.origin.ip, userAgent: input.origin.userAgent });
    const session = liveSession(lines, input.record.token, key, now);
    const sessionId = session ? session.sessionId ?? session.id : null;
    if (!sessionId || lines.some((l) => l.kind === "page" && l.sessionId === sessionId && l.page === input.page)) {
      return { add: [], result: undefined };
    }
    return { add: [{ ...baseLine("page", input, now), sessionId, page: input.page }], result: undefined };
  });
}

export function recordPinFailed(input: EventInput, now = Date.now()): Promise<void> {
  return append(() => ({ add: [baseLine("pin-failed", input, now)], result: undefined }));
}

export function recordChanges(input: EventInput & { name: string; comment: string; reviewId: string }, now = Date.now()): Promise<void> {
  return append(() => ({
    add: [{ ...baseLine("changes", input, now), name: input.name, comment: input.comment, reviewId: input.reviewId }],
    result: undefined,
  }));
}

// ------------------------------------------------------------- timeline

export type TimelineKind = "opened" | "pin-failed" | "preview" | "approved" | "changes" | "downloaded";

export interface TimelineEvent extends ClientInfo {
  id: string;
  kind: TimelineKind;
  at: string;
  audience: Audience;
  token: string;
  revision: number;
  visitorId: string | null;
  /** Counts distinct devices: the visitor id, else a hash of IP + browser. */
  visitor: string;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  screen?: string;
  /** opened: reloads in the session, distinct pages seen, and when it was last active. */
  views?: number;
  pagesViewed?: number;
  lastSeenAt?: string;
  name?: string;
  comment?: string;
  sha256?: string;
}

export interface ActivitySummary {
  /** Sessions by visitors (not the owner, not previews). */
  opens: number;
  /** Distinct visitor ids (devices). */
  visitors: number;
  /** Distinct IPs, a second hint. */
  ips: number;
  lastOpenAt: string | null;
  previews: number;
  ownerOpens: number;
  approvals: number;
  changes: number;
  downloads: number;
}

export interface Activity {
  summary: ActivitySummary;
  /** Newest first. */
  events: TimelineEvent[];
}

function fromProof(proof: ShareProof): TimelineEvent {
  const visitorId = (proof as { visitorId?: string | null }).visitorId ?? null;
  return {
    id: proof.id,
    kind: proof.kind === "download" ? "downloaded" : "approved",
    at: proof.at,
    audience: "visitor",
    token: proof.token,
    revision: proof.revision,
    visitorId,
    visitor: visitorKey({ visitorId, ip: proof.ip, userAgent: proof.userAgent }),
    ip: proof.ip,
    country: (proof as { country?: string | null }).country ?? null,
    userAgent: proof.userAgent,
    ...parseUserAgent(proof.userAgent),
    name: proof.name,
    ...(proof.kind === "download" ? { sha256: proof.sha256 } : {}),
  };
}

/**
 * The design's merged timeline: opens (with their reloads and pages folded
 * in), wrong PINs, previews, change requests, approvals and downloads, from
 * every link the design has had. Change requests and approvals made before
 * the logs existed come from the current link's reviews.
 */
export async function activityFor(owner: string, designId: string, current: ShareRecord | null): Promise<Activity> {
  await queue;
  const lines = (await load()).filter((l) => l.owner === owner && l.designId === designId);
  const proofs = (await readProofs()).filter((p) => p.owner === owner && p.designId === designId);
  const events: TimelineEvent[] = [];
  const opens = new Map<string, TimelineEvent>();
  const pages = new Map<string, Set<number>>();

  for (const line of lines) {
    if (line.kind === "view" || line.kind === "page") {
      const open = line.sessionId ? opens.get(line.sessionId) : undefined;
      if (open) {
        open.lastSeenAt = line.at;
        if (line.kind === "view") {
          open.views = (open.views ?? 1) + 1;
        } else if (line.page !== undefined) {
          const seen = pages.get(open.id) ?? new Set<number>();
          seen.add(line.page);
          pages.set(open.id, seen);
          open.pagesViewed = seen.size;
        }
      }
      continue;
    }
    const event: TimelineEvent = {
      id: line.id,
      kind: line.kind,
      at: line.at,
      audience: line.audience,
      token: line.token,
      revision: line.revision,
      visitorId: line.visitorId,
      visitor: visitorKey(line),
      ip: line.ip,
      country: line.country,
      userAgent: line.userAgent,
      browser: line.browser,
      os: line.os,
      device: line.device,
      ...(line.screen ? { screen: line.screen } : {}),
      ...(line.name !== undefined ? { name: line.name } : {}),
      ...(line.comment !== undefined ? { comment: line.comment } : {}),
    };
    if (line.kind === "opened") {
      event.views = 1;
      event.pagesViewed = 1;
      event.lastSeenAt = line.at;
      opens.set(line.sessionId ?? line.id, event);
      pages.set(event.id, new Set([0]));
    }
    events.push(event);
  }
  events.push(...proofs.map(fromProof));

  // Reviews from before the logs (the current link only): change requests and approvals.
  const logged = new Set([...lines.map((l) => l.reviewId), ...proofs.map((p) => (p.kind === "approval" ? p.reviewId : undefined))].filter(Boolean));
  for (const review of current?.reviews ?? []) {
    if (logged.has(review.id)) {
      continue;
    }
    events.push({
      id: review.id,
      kind: review.decision === "approved" ? "approved" : "changes",
      at: review.at,
      audience: "visitor",
      token: current?.token ?? "",
      revision: review.revision,
      visitorId: null,
      visitor: visitorKey({ visitorId: null, ip: review.ip ?? null, userAgent: review.userAgent ?? null }),
      ip: review.ip ?? null,
      country: null,
      userAgent: review.userAgent ?? null,
      ...parseUserAgent(review.userAgent ?? null),
      name: review.name,
      ...(review.comment ? { comment: review.comment } : {}),
    });
  }

  // Newest first; events in the same millisecond keep their natural order (open → review → download).
  const rank: Record<TimelineKind, number> = { "preview": 0, "pin-failed": 0, "opened": 1, "changes": 2, "approved": 3, "downloaded": 4 };
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || rank[b.kind] - rank[a.kind]);
  const visitorOpens = events.filter((e) => e.kind === "opened" && e.audience === "visitor");
  return {
    summary: {
      opens: visitorOpens.length,
      visitors: new Set(visitorOpens.map((e) => e.visitor)).size,
      ips: new Set(visitorOpens.map((e) => e.ip).filter(Boolean)).size,
      lastOpenAt: visitorOpens[0]?.lastSeenAt ?? visitorOpens[0]?.at ?? null,
      previews: events.filter((e) => e.kind === "preview").length,
      ownerOpens: events.filter((e) => e.kind === "opened" && e.audience === "owner").length,
      approvals: events.filter((e) => e.kind === "approved").length,
      changes: events.filter((e) => e.kind === "changes").length,
      downloads: events.filter((e) => e.kind === "downloaded").length,
    },
    events,
  };
}

// ------------------------------------------------------------- open notifications

/**
 * At most one "link opened" message per link every 10 minutes. Opens in
 * between are held and go out together when the window ends.
 */
export class OpenThrottle<T> {
  private readonly state = new Map<string, { lastSent: number; pending: T[]; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    private readonly windowMs: number,
    private readonly send: (key: string, items: T[]) => void,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
  ) {}

  submit(key: string, item: T, now = Date.now()): void {
    const entry = this.state.get(key) ?? { lastSent: Number.NEGATIVE_INFINITY, pending: [], timer: null };
    this.state.set(key, entry);
    if (!entry.timer && now - entry.lastSent >= this.windowMs) {
      entry.lastSent = now;
      this.send(key, [item]);
      return;
    }
    entry.pending.push(item);
    entry.timer ??= this.schedule(() => { this.flush(key); }, Math.max(0, entry.lastSent + this.windowMs - now));
  }

  /** Sends what is held for `key` (the window's end). */
  flush(key: string, now = Date.now()): void {
    const entry = this.state.get(key);
    if (!entry) {
      return;
    }
    entry.timer = null;
    if (entry.pending.length === 0) {
      return;
    }
    const items = entry.pending;
    entry.pending = [];
    entry.lastSent = now;
    this.send(key, items);
  }

  /** Tests: forget everything. */
  reset(): void {
    for (const entry of this.state.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.state.clear();
  }
}
