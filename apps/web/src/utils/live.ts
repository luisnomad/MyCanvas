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
  | { type: "lock.changed"; id: string; lock: DesignLock | null }
  | { type: "assets.changed" }
  | { type: "fonts.changed" }
  | { type: "reconnected" };

const EVENT_TYPES = ["design.updated", "design.created", "design.deleted", "lock.changed", "assets.changed", "fonts.changed"];

type Handler = (event: LiveEvent) => void;

const handlers = new Set<Handler>();
let source: EventSource | null = null;
let connectedBefore = false;

function dispatch(event: LiveEvent): void {
  for (const handler of [...handlers]) {
    handler(event);
  }
}

function open(): void {
  if (source || typeof EventSource === "undefined") {
    return;
  }
  source = new EventSource("/api/events");
  source.addEventListener("ready", () => {
    if (connectedBefore) {
      dispatch({ type: "reconnected" });
    }
    connectedBefore = true;
  });
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (message) => {
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
    if (handlers.size === 0 && source) {
      source.close();
      source = null;
      connectedBefore = false;
    }
  };
}
