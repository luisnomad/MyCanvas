import { type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { type Workspace } from "./storage";

/*
 * Live updates: every open editor tab (and the agent, if it wants) keeps one
 * Server-Sent Events stream for its workspace. Events carry ids only; clients
 * fetch what changed. Single server process, so an in-memory bus is enough.
 */

export type Actor = "agent" | "human";

export type WorkspaceEvent =
  | { type: "design.updated"; id: string; revision: number; by: Actor; clientId: string | null }
  | { type: "design.created"; id: string; folderId?: string; by: Actor; clientId: string | null }
  | { type: "design.deleted"; id: string; by: Actor; clientId: string | null }
  | { type: "lock.changed"; id: string; lock: unknown }
  | { type: "assets.changed" }
  | { type: "fonts.changed" };

type Listener = (event: WorkspaceEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function publish(ws: Workspace, event: WorkspaceEvent): void {
  for (const listener of listeners.get(ws.key) ?? []) {
    listener(event);
  }
}

export function subscribe(ws: Workspace, listener: Listener): () => void {
  let set = listeners.get(ws.key);
  if (!set) {
    set = new Set();
    listeners.set(ws.key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(ws.key);
    }
  };
}

/** Number of open streams for a workspace (tests, diagnostics). */
export function listenerCount(ws: Workspace): number {
  return listeners.get(ws.key)?.size ?? 0;
}

const HEARTBEAT_MS = 25_000;

/** The client's tab id (X-MyCanvas-Client), so it can ignore its own echoes. */
export function clientIdOf(c: Context): string | null {
  const value = c.req.header("x-mycanvas-client")?.trim();
  return value !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/** An SSE response streaming the workspace's events until the client leaves. */
export function eventStream(c: Context, ws: Workspace): Response {
  c.header("Cache-Control", "no-cache, no-transform");
  // Stops nginx-style proxies from buffering the stream.
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const queue: WorkspaceEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = subscribe(ws, (event) => {
      queue.push(event);
      wake?.();
    });
    const heartbeat = setInterval(() => {
      wake?.();
    }, HEARTBEAT_MS);
    stream.onAbort(() => {
      unsubscribe();
      clearInterval(heartbeat);
      wake?.();
    });
    try {
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted && !stream.closed) {
        const event = queue.shift();
        if (event) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
        if (queue.length === 0 && !stream.aborted) {
          // Woken by the heartbeat: a comment line keeps proxies from closing the stream.
          await stream.write(": ping\n\n");
        }
      }
    } finally {
      unsubscribe();
      clearInterval(heartbeat);
    }
  });
}
