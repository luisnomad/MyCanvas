import path from "node:path";
import { type DesignLock } from "@mycanvas/shared";
import { type Actor, publish } from "./events";
import { type Workspace, readJsonFile, writeJsonFile } from "./storage";

/*
 * Design locks (docs/AGENT_API.md, "Lock model"). The first edit locks a
 * design; only an intentional unlock frees it, so there are no timeouts and
 * locks are kept on disk (locks.json in the workspace) to survive restarts.
 */

export type { DesignLock };

export type LockResult =
  | { ok: true; lock: DesignLock; changed: boolean }
  | { ok: false; lock: DesignLock };

function locksFile(ws: Workspace): string {
  return path.join(ws.root, "locks.json");
}

const cache = new Map<string, Map<string, DesignLock>>();

async function load(ws: Workspace): Promise<Map<string, DesignLock>> {
  let locks = cache.get(ws.key);
  if (!locks) {
    const stored = (await readJsonFile<Record<string, DesignLock>>(locksFile(ws))) ?? {};
    locks = new Map(Object.entries(stored));
    cache.set(ws.key, locks);
  }
  return locks;
}

async function save(ws: Workspace, locks: Map<string, DesignLock>): Promise<void> {
  await writeJsonFile(locksFile(ws), Object.fromEntries(locks));
}

function announce(ws: Workspace, designId: string, lock: DesignLock | null): void {
  publish(ws, { type: "lock.changed", id: designId, lock });
}

/** Forgets cached locks (tests simulating a server restart). */
export function clearLockCache(): void {
  cache.clear();
}

export async function getLock(ws: Workspace, designId: string): Promise<DesignLock | null> {
  return (await load(ws)).get(designId) ?? null;
}

export async function listLocks(ws: Workspace): Promise<DesignLock[]> {
  return [...(await load(ws)).values()];
}

/**
 * Takes the lock for `holder` if the design is free or already theirs.
 * Fails (returning the current lock) when the other side holds it.
 */
export async function acquireLock(ws: Workspace, designId: string, holder: Actor, label: string): Promise<LockResult> {
  const locks = await load(ws);
  const current = locks.get(designId);
  if (current) {
    if (current.holder === holder) {
      return { ok: true, lock: current, changed: false };
    }
    return { ok: false, lock: current };
  }
  const lock: DesignLock = { designId, holder, label, email: ws.email, since: new Date().toISOString() };
  locks.set(designId, lock);
  await save(ws, locks);
  announce(ws, designId, lock);
  return { ok: true, lock, changed: true };
}

/** Releases the lock if `holder` has it. Returns whether a lock was released. */
export async function releaseLock(ws: Workspace, designId: string, holder: Actor): Promise<boolean> {
  const locks = await load(ws);
  if (locks.get(designId)?.holder !== holder) {
    return false;
  }
  locks.delete(designId);
  takenFromAgent.delete(`${ws.key}/${designId}`);
  await save(ws, locks);
  announce(ws, designId, null);
  return true;
}

/** Designs Luis took from Claude, so Claude's next write hears "lock_lost". */
const takenFromAgent = new Set<string>();

/** True while the design's current lock was taken over from Claude. */
export function wasTakenFromAgent(ws: Workspace, designId: string): boolean {
  return takenFromAgent.has(`${ws.key}/${designId}`);
}

/** Luis takes the design from Claude (or keeps his own lock). */
export async function takeOver(ws: Workspace, designId: string, label: string): Promise<DesignLock> {
  const locks = await load(ws);
  const current = locks.get(designId);
  if (current?.holder === "human") {
    return current;
  }
  const lock: DesignLock = { designId, holder: "human", label, email: ws.email, since: new Date().toISOString() };
  if (current?.holder === "agent") {
    takenFromAgent.add(`${ws.key}/${designId}`);
  }
  locks.set(designId, lock);
  await save(ws, locks);
  announce(ws, designId, lock);
  return lock;
}

/** Drops any lock on a deleted design. */
export async function dropLock(ws: Workspace, designId: string): Promise<void> {
  const locks = await load(ws);
  takenFromAgent.delete(`${ws.key}/${designId}`);
  if (locks.delete(designId)) {
    await save(ws, locks);
    announce(ws, designId, null);
  }
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs read-modify-write steps on one design one at a time, so an editor
 * save and an agent batch can't interleave and lose each other's changes.
 */
export function serialized<T>(ws: Workspace, designId: string, task: () => Promise<T>): Promise<T> {
  const key = `${ws.key}/${designId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });
  return run;
}
