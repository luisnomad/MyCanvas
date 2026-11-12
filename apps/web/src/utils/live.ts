import { type DesignLock } from "@mycanvas/shared";

/*
 * Live updates from the server (Server-Sent Events, /api/events): one
 * stream per tab, shared by whoever listens. Events carry ids only; the
 * listener fetches what changed. The browser reconnects by itself; after a
 * reconnect listeners get "reconnected" so they can catch up on anything
 * they missed.
 */

export type LiveEvent =
  | { type: "design.updated"; id: string; revision: number; by: "agent" | "human"; clientId: string | null }
  | { type: "design.created"; id: string; folderId?: string; by: "agent" | "human"; clientId: string | null }
  | { type: "design.deleted"; id: string; by: "agent" | "human"; clientId: string | null }
  | { type: "design.thumbnail"; id: string }
  | { type: "lock.changed"; id: string; lock: DesignLock | null }
  | { type: "assets.changed" }
  | { type: "fonts.changed" }
  | { type: "reconnected" };

const EVENT_TYPES = ["design.updated", "design.created", "design.deleted", "design.thumbnail", "lock.changed", "assets.changed", "fonts.changed"];

type Handler = (event: LiveEvent) => void;

const handlers = new Set<Handler>();
let source: EventSource | null = null;
let connectedBefore = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
/** Last time anything arrived (the server pings every 25 s). */
let lastSeen = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
const SILENCE_LIMIT_MS = 60_000;

/** Starts over with a new stream (the old one is dead or given up). */
function reconnect(delay: number): void {
  source?.close();
  source = null;
  if (retryTimer) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (handlers.size > 0) {
      open();
    }
  }, delay);
}

function dispatch(event: LiveEvent): void {
  for (const handler of [...handlers]) {
    handler(event);
  }
}

function open(): void {
  if (source || typeof EventSource === "undefined") {
    return;
  }
  const opened = new EventSource("/api/events");
  source = opened;
  lastSeen = Date.now();
  // A stream can die without the browser noticing (a proxy that keeps the
  // browser's side open after the server restarted): reconnect when the
  // server's pings stop.
  watchdog ??= setInterval(() => {
    if (source && Date.now() - lastSeen > SILENCE_LIMIT_MS) {
      reconnect(0);
    }
  }, 15_000);
  opened.addEventListener("ping", () => {
    lastSeen = Date.now();
  });
  opened.addEventListener("ready", () => {
    lastSeen = Date.now();
    retryDelay = 1000;
    if (connectedBefore) {
      dispatch({ type: "reconnected" });
    }
    connectedBefore = true;
  });
  // The browser retries dropped streams by itself, but gives up for good
  // after an error response (e.g. a 502 while the server restarts during a
  // deploy). Then start over, waiting a little longer each time.
  opened.addEventListener("error", () => {
    if (opened.readyState !== EventSource.CLOSED || source !== opened) {
      return;
    }
    reconnect(retryDelay);
    retryDelay = Math.min(30_000, retryDelay * 2);
  });
  for (const type of EVENT_TYPES) {
    opened.addEventListener(type, (message) => {
      lastSeen = Date.now();
      try {
        dispatch(JSON.parse((message as MessageEvent<string>).data) as LiveEvent);
      } catch {
        // A malformed event; ignore it.
      }
    });
  }
}

/** Listens to live events; returns the unsubscribe function. */
export function onLive(handler: Handler): () => void {
  handlers.add(handler);
  open();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      source?.close();
      source = null;
      connectedBefore = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
    }
  };
}
