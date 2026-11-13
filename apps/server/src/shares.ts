import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { dataDir, readJsonFile, writeJsonFile } from "./storage";

/*
 * Share links: a read-only, live view of one design for people outside
 * MyCanvas (a customer). Anyone with the link sees the design; an optional
 * PIN adds a second check. "Throwing away" a link or changing its PIN
 * rotates the access key, so every open viewer has to start over.
 *
 * Records live in one file for the whole server (data/shares.json), keyed
 * by token, because a viewer arrives with nothing but the token.
 */

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export interface ShareRecord {
  token: string;
  /** Owner's identity (workspaceFor key source). */
  email: string;
  designId: string;
  /** "salt:hash" (hex, scrypt) when a PIN is set. */
  pin?: string;
  /** What a viewer's cookie must hold; changes with the link or the PIN. */
  accessKey: string;
  createdAt: string;
  /** After this the link stops working (kept so the editor can show it and extend it). */
  expiresAt?: string;
  /** When a viewer last opened the design (at most once a minute). */
  lastViewedAt?: string;
}

/** What the editor sees about a design's link (never the PIN or key). */
export interface ShareInfo {
  token: string;
  path: string;
  hasPin: boolean;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  lastViewedAt: string | null;
}

export const PIN_PATTERN = /^[0-9]{4,8}$/;
/** Link lifetimes the editor offers, in days. */
export const EXPIRY_DAYS = [1, 7, 30] as const;
const DAY_MS = 24 * 60 * 60_000;
const VIEW_NOTE_MS = 60_000;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

function sharesFile(): string {
  return path.join(dataDir, "shares.json");
}

let cache: Record<string, ShareRecord> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<Record<string, ShareRecord>> {
  cache ??= (await readJsonFile<Record<string, ShareRecord>>(sharesFile())) ?? {};
  return cache;
}

/** Runs `change` on the records one at a time and saves the result. */
function mutate<T>(change: (records: Record<string, ShareRecord>) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const records = await load();
    const result = await change(records);
    await writeJsonFile(sharesFile(), records);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Forgets the in-memory copy (tests use a fresh data dir). */
export function resetShareCache(): void {
  cache = null;
}

export function isShareToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function isExpired(record: ShareRecord, now = Date.now()): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now;
}

export function shareInfo(record: ShareRecord, now = Date.now()): ShareInfo {
  return {
    token: record.token,
    path: `/s/${record.token}`,
    hasPin: record.pin !== undefined,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    expired: isExpired(record, now),
    lastViewedAt: record.lastViewedAt ?? null,
  };
}

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function pinMatches(record: ShareRecord, pin: string): Promise<boolean> {
  if (!record.pin) {
    return true;
  }
  const [saltHex = "", hashHex = ""] = record.pin.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(pin, Buffer.from(saltHex, "hex"), expected.length || 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function accessKeyMatches(record: ShareRecord, key: string | undefined): boolean {
  if (!key) {
    return false;
  }
  const a = Buffer.from(record.accessKey);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function shareByToken(token: string): Promise<ShareRecord | null> {
  if (!isShareToken(token)) {
    return null;
  }
  return (await load())[token] ?? null;
}

export async function shareForDesign(email: string, designId: string): Promise<ShareRecord | null> {
  return Object.values(await load()).find((record) => record.email === email && record.designId === designId) ?? null;
}

export interface ShareChange {
  /** A new PIN, null to remove it, undefined to keep it. */
  pin?: string | null;
  /** Throw the old link away and make a new one. */
  newLink?: boolean;
  /** Link lifetime from now, in days (one of EXPIRY_DAYS); null never expires; undefined keeps it. */
  expiresInDays?: number | null;
}

/** Creates the design's link or changes it; returns the record. */
export function saveShare(email: string, designId: string, change: ShareChange): Promise<ShareRecord> {
  return mutate(async (records) => {
    let record = Object.values(records).find((r) => r.email === email && r.designId === designId);
    if (record && change.newLink) {
      delete records[record.token];
      record = { ...record, token: randomBytes(16).toString("hex"), createdAt: new Date().toISOString() };
      delete record.lastViewedAt;
    }
    record ??= { token: randomBytes(16).toString("hex"), email, designId, accessKey: "", createdAt: new Date().toISOString() };
    if (change.pin === null) {
      delete record.pin;
    } else if (change.pin !== undefined) {
      record.pin = await hashPin(change.pin);
    }
    if (change.expiresInDays === null) {
      delete record.expiresAt;
    } else if (change.expiresInDays !== undefined) {
      record.expiresAt = new Date(Date.now() + change.expiresInDays * DAY_MS).toISOString();
    }
    // A new link or PIN shuts out everyone who was let in before.
    if (!record.accessKey || change.newLink || change.pin !== undefined) {
      record.accessKey = randomBytes(24).toString("hex");
    }
    records[record.token] = record;
    return record;
  });
}

/** Records that a viewer opened the link (written at most once a minute). */
export async function noteViewed(token: string, now = Date.now()): Promise<void> {
  const record = (await load())[token];
  if (!record || (record.lastViewedAt && now - Date.parse(record.lastViewedAt) < VIEW_NOTE_MS)) {
    return;
  }
  await mutate((records) => {
    const current = records[token];
    if (current) {
      current.lastViewedAt = new Date(now).toISOString();
    }
  });
}

/** Stops sharing the design; returns the removed record, if any. */
export function deleteShare(email: string, designId: string): Promise<ShareRecord | null> {
  return mutate((records) => {
    const record = Object.values(records).find((r) => r.email === email && r.designId === designId) ?? null;
    if (record) {
      delete records[record.token];
    }
    return record;
  });
}

/*
 * Wrong-PIN brake: after 8 misses a link refuses PIN attempts for 10
 * minutes (per link, in memory; a 4-digit PIN would otherwise fall quickly).
 */
const MAX_MISSES = 8;
const LOCKOUT_MS = 10 * 60_000;
const misses = new Map<string, { count: number; until: number }>();

export function pinLockedOut(token: string, now = Date.now()): boolean {
  const entry = misses.get(token);
  return entry !== undefined && entry.count >= MAX_MISSES && entry.until > now;
}

export function notePinResult(token: string, ok: boolean, now = Date.now()): void {
  if (ok) {
    misses.delete(token);
    return;
  }
  const entry = misses.get(token);
  const fresh = !entry || entry.until <= now;
  const count = fresh ? 1 : entry.count + 1;
  misses.set(token, { count, until: now + LOCKOUT_MS });
}
