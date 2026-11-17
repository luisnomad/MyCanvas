import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type Acknowledgement, type ReviewDecision } from "./shares";
import { dataDir } from "./storage";

/*
 * Proof of sign-off: an append-only log (data/share-proofs.jsonl, one JSON
 * object per line) of every approval and every download of an approved
 * PDF from a share link. Lines are only ever added, never rewritten, and
 * the log outlives the link itself (stopping or replacing a link keeps it),
 * so Luis can show who approved and took which file, and when.
 */

/** Where a request came from, as the proxies in front of the server tell it. */
export interface RequestOrigin {
  /** Best guess at the viewer's address (see clientAddress). */
  ip: string | null;
  /** The raw forwarding headers, kept as they arrived. */
  forwardedFor: string | null;
  realIp: string | null;
  cfConnectingIp: string | null;
  userAgent: string | null;
}

interface ProofBase extends RequestOrigin {
  id: string;
  at: string;
  /** The share link used (its token). */
  token: string;
  /** Owner's identity; filters the log per workspace, never shown to viewers. */
  owner: string;
  designId: string;
  designName: string;
  /** The design revision approved or downloaded. */
  revision: number;
  /** The viewer's name, as typed. */
  name: string;
  acknowledgement: Acknowledgement;
  /** The page's visitor id and Cloudflare's country (entries since 2026-11-17). */
  visitorId?: string | null;
  country?: string | null;
}

export interface ApprovalProof extends ProofBase {
  kind: "approval";
  reviewId: string;
  decision: ReviewDecision;
}

export interface DownloadProof extends ProofBase {
  kind: "download";
  /** SHA-256 (hex) of the exact PDF bytes served. */
  sha256: string;
  bytes: number;
  fileName: string;
  /** The approval that unlocked the download. */
  reviewId: string;
}

export type ShareProof = ApprovalProof | DownloadProof;

/** What the editor and the agent see of a download (no owner email). */
export type DownloadInfo = Omit<DownloadProof, "owner">;

function proofsFile(): string {
  return path.join(dataDir, "share-proofs.jsonl");
}

let queue: Promise<unknown> = Promise.resolve();

/** Adds one line to the log (one write at a time); returns the stored entry. */
export function appendProof<T extends ShareProof>(entry: Omit<T, "id" | "at"> & { at?: string }): Promise<T> {
  const proof = { id: randomBytes(8).toString("hex"), at: new Date().toISOString(), ...entry } as unknown as T;
  const run = queue.then(async () => {
    await mkdir(path.dirname(proofsFile()), { recursive: true });
    await appendFile(proofsFile(), `${JSON.stringify(proof)}\n`, "utf8");
    return proof;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Every entry in the log, oldest first (a torn last line is skipped). */
export async function readProofs(): Promise<ShareProof[]> {
  await queue;
  let text: string;
  try {
    text = await readFile(proofsFile(), "utf8");
  } catch {
    return [];
  }
  const out: ShareProof[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line) as ShareProof);
    } catch {
      // A line cut short by a crash; the rest still counts.
    }
  }
  return out;
}

/** The design's downloads in the owner's workspace, oldest first. */
export async function downloadsFor(owner: string, designId: string): Promise<DownloadInfo[]> {
  return (await readProofs())
    .filter((proof): proof is DownloadProof => proof.kind === "download" && proof.owner === owner && proof.designId === designId)
    .map(({ owner: _owner, ...rest }) => rest);
}

/** How many times a link's PDF was downloaded (a ceiling against abuse). */
export async function downloadCount(token: string): Promise<number> {
  return (await readProofs()).filter((proof) => proof.kind === "download" && proof.token === token).length;
}

function header(headers: { get(name: string): string | null | undefined }, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value ? value.slice(0, 500) : null;
}

/**
 * The viewer's address. Public traffic arrives through Cloudflare Tunnel and
 * Traefik (Coolify): Cloudflare sets CF-Connecting-IP and starts
 * X-Forwarded-For with the client; Traefik adds X-Real-IP (the hop before
 * it). So: CF-Connecting-IP, else the first X-Forwarded-For entry, else
 * X-Real-IP. The raw headers are kept too.
 */
export function requestOrigin(headers: { get(name: string): string | null | undefined }): RequestOrigin {
  const cfConnectingIp = header(headers, "cf-connecting-ip");
  const forwardedFor = header(headers, "x-forwarded-for");
  const realIp = header(headers, "x-real-ip");
  const first = forwardedFor?.split(",")[0]?.trim();
  const firstForwarded = first !== undefined && first !== "" ? first : null;
  return {
    ip: cfConnectingIp ?? firstForwarded ?? realIp,
    forwardedFor,
    realIp,
    cfConnectingIp,
    userAgent: header(headers, "user-agent"),
  };
}
