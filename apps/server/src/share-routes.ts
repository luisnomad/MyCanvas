import { type Context, type Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Design, allLayers } from "@mycanvas/shared";
import { AGENT_BASE } from "./agent/routes";
import { type AppEnv } from "./app";
import { readDesign } from "./designs";
import { eventStream, publish } from "./events";
import { fontFaceCss, isSafeFontFile, listFonts, readFontFile } from "./fonts";
import { notify } from "./notify";
import { RendererUnavailable, runHeadless } from "./renderer";
import { type ApprovalProof, type DownloadProof, appendProof, downloadCount, downloadsFor, requestOrigin } from "./share-proofs";
import {
  type ShareLanguage,
  type ShareRecord,
  ACK_VERSION,
  EXPIRY_DAYS,
  SHARE_LANGUAGES,
  PIN_PATTERN,
  REVIEW_COMMENT_MAX,
  REVIEW_NAME_MAX,
  accessKeyMatches,
  acknowledgement,
  addReview,
  approvalOf,
  deleteShare,
  isExpired,
  notePinResult,
  noteViewed,
  pinLockedOut,
  pinMatches,
  saveShare,
  shareByToken,
  shareForDesign,
  shareInfo,
  shareLanguage,
} from "./shares";
import { type Workspace, dataDir, isSafeId, webDistDir, workspaceFor } from "./storage";

/*
 * Share links (see shares.ts).
 *
 * Editor side, signed in like the rest of /api: GET/PUT/DELETE
 * /api/designs/:id/share; the agent API has the same at
 * /api/agent/v1/designs/:id/share (PUT { pin?, expiresInDays?,
 * approvalRequested?, newLink? }; GET returns the reviews).
 *
 * Viewer side, public, everything under /s/<token> so a single path can be
 * let through the sign-in in front of the public host:
 *   /s/<token>              the viewer page (the web app)
 *   /s/<token>/design       the design, read-only
 *   /s/<token>/unlock       POST { pin } → sets the viewer cookie
 *   /s/<token>/review       POST { name, decision, comment, revision,
 *                           acknowledged, ackVersion, language } when the
 *                           link asks for approval (approving needs the
 *                           sign-off box ticked)
 *   /s/<token>/download     POST { name, revision, acknowledged, ackVersion,
 *                           language } → the approved revision as PDF, once
 *                           it is approved; each download is logged as proof
 *                           (share-proofs.ts)
 *   /s/<token>/events       live updates for this design only
 *   /s/<token>/assets/<f>   images the design uses
 *   /s/<token>/fonts.json, fonts.css, fonts/<f>   uploaded fonts
 * The cookie (path /s/<token>) carries the link's access key, so images,
 * fonts and the event stream work without anything in the URL.
 */

const COOKIE = "mycanvas_share";

interface ShareRouteDeps {
  isSafeAssetFile: (file: string) => boolean;
  imageTypes: Record<string, string>;
}

/**
 * What a viewer learns about the approval: whether it's asked, the latest
 * answer (name, decision, comment, when; never where it came from), the
 * sign-off text to tick, and whether the approved PDF can be downloaded.
 */
function approvalFor(record: ShareRecord, design: Design) {
  const latest = record.reviews?.at(-1) ?? null;
  const revision = design.revision ?? 0;
  const language = shareLanguage(record);
  return {
    requested: record.approvalRequested === true,
    revision,
    language,
    latest: latest && { name: latest.name, decision: latest.decision, comment: latest.comment, at: latest.at, revision: latest.revision },
    acknowledgement: acknowledgement(language, revision),
    /** The same text in every page language, for a viewer who switches it. */
    acknowledgements: Object.fromEntries(SHARE_LANGUAGES.map((lang) => [lang, acknowledgement(lang, revision)])),
    downloadable: record.approvalRequested === true && approvalOf(record, revision) !== null,
  };
}

/** The viewer's language for the sign-off text: what the page showed, else the link's. */
function viewerLanguage(record: ShareRecord, value: unknown): ShareLanguage {
  return (SHARE_LANGUAGES as readonly unknown[]).includes(value) ? value as ShareLanguage : shareLanguage(record);
}

/** The PDF a customer downloads: the editor's own vector export at 2x (about 192 dpi for pictures). */
type SharePdfExporter = (ws: Workspace, design: Design) => Promise<Buffer>;
const SHARE_PDF_SCALE = 2;
/** Per link: generous for re-downloads, a ceiling for abuse. */
const DOWNLOADS_MAX = 500;

const headlessExporter: SharePdfExporter = async (_ws, design) => {
  if (process.env.MYCANVAS_RENDERER === "off") {
    throw new RendererUnavailable("the renderer is off");
  }
  return Buffer.from(await runHeadless("exportPdf", design.id, SHARE_PDF_SCALE), "base64");
};
let exportPdf: SharePdfExporter = headlessExporter;

/** Tests: replace the PDF export (null restores the headless renderer). */
export function setSharePdfExporter(exporter: SharePdfExporter | null): void {
  exportPdf = exporter ?? headlessExporter;
}

function pdfCacheFile(ws: Workspace, designId: string, revision: number): string {
  return path.join(dataDir, "share-pdfs", ws.key, `${designId}-r${String(revision)}.pdf`);
}

/**
 * The approved revision's PDF. Made once and kept, so every download of a
 * revision is the very same file (and the same SHA-256). Null when the
 * design changed while it was being made.
 */
async function approvedPdf(ws: Workspace, design: Design, revision: number): Promise<Buffer | null> {
  const file = pdfCacheFile(ws, design.id, revision);
  try {
    return await readFile(file);
  } catch {
    // Not made yet.
  }
  const pdf = await exportPdf(ws, design);
  const after = await readDesign(ws, design.id);
  if ((after?.revision ?? -1) !== revision) {
    return null;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, pdf);
  await rename(temp, file);
  return pdf;
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]+/g, "").replace(/["\\]/g, "") || "design.pdf";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function pdfFileName(design: Design, revision: number): string {
  const name = design.name.replace(/[^\p{L}\p{N} ._-]+/gu, "").trim().slice(0, 80) || "design";
  return `${name} v${String(revision)}.pdf`;
}

function publicUrl(): string | null {
  const url = process.env.MYCANVAS_PUBLIC_URL?.trim() ?? "";
  return url === "" ? null : url;
}

/** The editor's (and the agent's) view of a link, with its full public URL when the server knows it. */
async function shareResponse(email: string, designId: string, record: ShareRecord | null) {
  const base = publicUrl();
  return {
    share: record ? shareInfo(record) : null,
    publicUrl: base,
    url: record && base ? `${base.replace(/\/+$/, "")}/s/${record.token}` : null,
    /** Downloads of approved PDFs (proof of delivery), oldest first; kept after the link stops. */
    downloads: await downloadsFor(email, designId),
  };
}

function withoutThumbnails(design: Design): Design {
  const { thumbnail: _thumbnail, ...rest } = design;
  return { ...rest, pages: design.pages.map(({ thumbnail: _pageThumbnail, ...page }) => page) };
}

/** Image files the design draws (photos, frame contents, cutouts). */
export function designAssets(design: Design): Set<string> {
  const assets = new Set<string>();
  for (const layer of allLayers(design)) {
    if (layer.type === "image") {
      assets.add(layer.asset);
    } else if (layer.type === "frame" && layer.content) {
      assets.add(layer.content.asset);
    }
  }
  return assets;
}

const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function expiredResponse(c: Context, record: ShareRecord): Response {
  return c.json({ error: "This link has expired", expired: true, language: shareLanguage(record) }, 410, noStore);
}

interface Viewer { record: ShareRecord; ws: Workspace; design: Design }

/**
 * The link's record, workspace and design when the caller may see them;
 * otherwise the response to send (404 unknown or stopped, 401 PIN needed).
 */
async function viewer(c: Context): Promise<Viewer | Response> {
  const record = await shareByToken(c.req.param("token") ?? "");
  if (!record) {
    return c.json({ error: "This link isn't shared any more" }, 404, noStore);
  }
  if (isExpired(record)) {
    return expiredResponse(c, record);
  }
  const ws = await workspaceFor(record.email);
  const design = await readDesign(ws, record.designId);
  if (!design) {
    return c.json({ error: "This link isn't shared any more" }, 404, noStore);
  }
  // The link alone is enough unless it has a PIN: then the cookie from /unlock.
  if (record.pin !== undefined && !accessKeyMatches(record, getCookie(c, COOKIE))) {
    return c.json({ error: "Enter the PIN to see this design", pin: true, language: shareLanguage(record) }, 401, noStore);
  }
  return { record, ws, design };
}

/** The request's JSON object, or {} when there is none. */
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function cookiePath(record: ShareRecord): string {
  return `/s/${record.token}`;
}

function isHttps(c: Context): boolean {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

function grantAccess(c: Context, record: ShareRecord): void {
  setCookie(c, COOKIE, record.accessKey, {
    path: cookiePath(record),
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(c),
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function registerShareRoutes(app: Hono<AppEnv>, deps: ShareRouteDeps): void {
  // ── Editor side ──────────────────────────────────────────────────────
  // The same three routes for the signed-in editor and for the agent API
  // (Claude shares a design and reads the reviews back). Both work in the
  // owner's workspace; responses carry the full public `url` when known.
  for (const base of ["/api/designs", `${AGENT_BASE}/designs`]) {
    app.get(`${base}/:id/share`, async (c) => {
      const id = c.req.param("id");
      if (!isSafeId(id) || !await readDesign(c.get("ws"), id)) {
        return c.json({ error: "Not found" }, 404);
      }
      const record = await shareForDesign(c.get("ws").email, id);
      return c.json(await shareResponse(c.get("ws").email, id, record));
    });

    app.put(`${base}/:id/share`, async (c) => {
      const ws = c.get("ws");
      const id = c.req.param("id");
      if (!isSafeId(id) || !await readDesign(ws, id)) {
        return c.json({ error: "Not found" }, 404);
      }
      const body = await jsonBody(c);
      const pin = body.pin;
      if (pin !== undefined && pin !== null && (typeof pin !== "string" || !PIN_PATTERN.test(pin))) {
        return c.json({ error: "The PIN is 4 to 8 digits" }, 400);
      }
      const days = body.expiresInDays;
      if (days !== undefined && days !== null && !(EXPIRY_DAYS as readonly unknown[]).includes(days)) {
        return c.json({ error: `expiresInDays must be ${EXPIRY_DAYS.join(", ")} or null` }, 400);
      }
      const approval = body.approvalRequested;
      if (approval !== undefined && typeof approval !== "boolean") {
        return c.json({ error: "approvalRequested must be true or false" }, 400);
      }
      const language = body.language;
      if (language !== undefined && !(SHARE_LANGUAGES as readonly unknown[]).includes(language)) {
        return c.json({ error: `language must be ${SHARE_LANGUAGES.join(" or ")}` }, 400);
      }
      const record = await saveShare(ws.email, id, {
        ...(pin === undefined ? {} : { pin }),
        ...(approval === undefined ? {} : { approvalRequested: approval }),
        ...(language === undefined ? {} : { language: language as ShareLanguage }),
        ...(days === undefined ? {} : { expiresInDays: days as number | null }),
        newLink: body.newLink === true,
      });
      publish(ws, { type: "share.changed", id });
      return c.json(await shareResponse(ws.email, id, record));
    });

    app.delete(`${base}/:id/share`, async (c) => {
      const ws = c.get("ws");
      const id = c.req.param("id");
      await deleteShare(ws.email, id);
      publish(ws, { type: "share.changed", id });
      return c.json(await shareResponse(ws.email, id, null));
    });
  }

  // ── Viewer side (public) ─────────────────────────────────────────────
  app.get("/s/:token/design", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    void noteViewed(found.record.token).catch(() => undefined);
    return c.json({ design: withoutThumbnails(found.design), approval: approvalFor(found.record, found.design) }, 200, noStore);
  });

  app.post("/s/:token/review", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    if (found.record.approvalRequested !== true) {
      return c.json({ error: "This link doesn't ask for approval", code: "not-requested" }, 403, noStore);
    }
    const body = await jsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    const decision = body.decision;
    if (!name || name.length > REVIEW_NAME_MAX) {
      return c.json({ error: `Add your name (up to ${String(REVIEW_NAME_MAX)} characters)`, code: "name" }, 400, noStore);
    }
    if (decision !== "approved" && decision !== "changes") {
      return c.json({ error: "decision must be \"approved\" or \"changes\"", code: "decision" }, 400, noStore);
    }
    if (decision === "changes" && !comment) {
      return c.json({ error: "Say what should change", code: "comment" }, 400, noStore);
    }
    if (comment.length > REVIEW_COMMENT_MAX) {
      return c.json({ error: `Keep the comment under ${String(REVIEW_COMMENT_MAX)} characters`, code: "comment" }, 400, noStore);
    }
    // Approving is a formal sign-off: the viewer must tick the current sign-off text.
    if (decision === "approved" && (body.acknowledged !== true || body.ackVersion !== ACK_VERSION)) {
      return c.json({ error: "Tick the sign-off box to approve", code: "acknowledgement", ackVersion: ACK_VERSION }, 400, noStore);
    }
    // The review is for the version the viewer saw; if the design changed meanwhile, they must look again.
    const current = found.design.revision ?? 0;
    if (body.revision !== current) {
      return c.json({ error: "The design changed while you were looking. Check the new version first.", stale: true, code: "stale" }, 409, noStore);
    }
    const origin = requestOrigin(c.req.raw.headers);
    const ack = decision === "approved" ? acknowledgement(viewerLanguage(found.record, body.language), current) : undefined;
    const added = await addReview(found.record.token, {
      name,
      decision,
      comment,
      revision: current,
      ...(ack ? { acknowledgement: ack } : {}),
      ...(ack && origin.ip ? { ip: origin.ip } : {}),
      ...(ack && origin.userAgent ? { userAgent: origin.userAgent } : {}),
    });
    if (!added) {
      return c.json({ error: "This link can't take more reviews", code: "full" }, 429, noStore);
    }
    const saved = await shareByToken(found.record.token);
    if (added.repeat) {
      return c.json({ review: added.review, repeat: true, approval: saved ? approvalFor(saved, found.design) : null }, 200, noStore);
    }
    if (ack) {
      await appendProof<ApprovalProof>({
        kind: "approval",
        token: found.record.token,
        owner: found.record.email,
        designId: found.design.id,
        designName: found.design.name,
        revision: current,
        name,
        acknowledgement: ack,
        reviewId: added.review.id,
        decision,
        ...origin,
      });
    }
    publish(found.ws, { type: "share.changed", id: found.record.designId });
    void notify(found.ws, { kind: decision, designId: found.design.id, designName: found.design.name, reviewer: name, revision: current, ...(comment ? { comment } : {}) });
    return c.json({ review: added.review, approval: saved ? approvalFor(saved, found.design) : null }, 201, noStore);
  });

  app.post("/s/:token/download", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    const { record, ws, design } = found;
    if (record.approvalRequested !== true) {
      return c.json({ error: "This link doesn't ask for approval", code: "not-requested" }, 403, noStore);
    }
    const body = await jsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > REVIEW_NAME_MAX) {
      return c.json({ error: `Add your name (up to ${String(REVIEW_NAME_MAX)} characters)`, code: "name" }, 400, noStore);
    }
    if (body.acknowledged !== true || body.ackVersion !== ACK_VERSION) {
      return c.json({ error: "Tick the sign-off box to download", code: "acknowledgement", ackVersion: ACK_VERSION }, 400, noStore);
    }
    const current = design.revision ?? 0;
    if (body.revision !== current) {
      return c.json({ error: "The design changed while you were looking. Check the new version first.", stale: true, code: "stale" }, 409, noStore);
    }
    // Only the latest approved revision, and only once it is approved.
    const approval = approvalOf(record, current);
    if (!approval) {
      return c.json({ error: "Approve this version before downloading it", code: "not-approved" }, 403, noStore);
    }
    if (await downloadCount(record.token) >= DOWNLOADS_MAX) {
      return c.json({ error: "This link can't take more downloads", code: "full" }, 429, noStore);
    }
    let pdf: Buffer | null;
    try {
      pdf = await approvedPdf(ws, design, current);
    } catch (error) {
      console.warn(`share download ${design.id}:`, error instanceof Error ? error.message : error);
      return c.json({ error: "The PDF couldn't be made right now. Try again in a moment.", code: "export" }, 503, noStore);
    }
    if (!pdf) {
      return c.json({ error: "The design changed while you were looking. Check the new version first.", stale: true, code: "stale" }, 409, noStore);
    }
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    const fileName = pdfFileName(design, current);
    // The proof is written before a single byte leaves.
    await appendProof<DownloadProof>({
      kind: "download",
      token: record.token,
      owner: record.email,
      designId: design.id,
      designName: design.name,
      revision: current,
      name,
      acknowledgement: acknowledgement(viewerLanguage(record, body.language), current),
      sha256,
      bytes: pdf.length,
      fileName,
      reviewId: approval.id,
      ...requestOrigin(c.req.raw.headers),
    });
    publish(ws, { type: "share.changed", id: design.id });
    void notify(ws, { kind: "downloaded", designId: design.id, designName: design.name, reviewer: name, revision: current, sha256 });
    return c.body(new Uint8Array(pdf), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition(fileName),
      "X-MyCanvas-Sha256": sha256,
      ...noStore,
    });
  });

  app.post("/s/:token/unlock", async (c) => {
    const record = await shareByToken(c.req.param("token"));
    if (!record) {
      return c.json({ error: "This link isn't shared any more" }, 404, noStore);
    }
    if (isExpired(record)) {
      return expiredResponse(c, record);
    }
    if (pinLockedOut(record.token)) {
      return c.json({ error: "Too many wrong PINs. Try again in a few minutes.", code: "pin-locked" }, 429, noStore);
    }
    const body = await jsonBody(c);
    const pin = typeof body.pin === "string" ? body.pin.trim() : "";
    const ok = await pinMatches(record, pin);
    notePinResult(record.token, ok);
    if (!ok) {
      return c.json({ error: "That PIN isn't right", code: "pin-wrong" }, 401, noStore);
    }
    grantAccess(c, record);
    return c.json({ ok: true }, 200, noStore);
  });

  app.get("/s/:token/events", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    const id = found.record.designId;
    return eventStream(c, found.ws, (event) =>
      ((event.type === "design.updated" || event.type === "design.deleted" || event.type === "share.changed") && event.id === id) ||
      event.type === "fonts.changed");
  });

  app.get("/s/:token/assets/:file", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    const file = c.req.param("file");
    // Only what this design draws, never the rest of the workspace.
    if (!deps.isSafeAssetFile(file) || !designAssets(found.design).has(file)) {
      return c.notFound();
    }
    try {
      const bytes = await readFile(path.join(found.ws.assetsDir, file));
      return c.body(bytes, 200, {
        "Content-Type": deps.imageTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      });
    } catch {
      return c.notFound();
    }
  });

  app.get("/s/:token/fonts.json", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    return c.json(await listFonts(found.ws), 200, noStore);
  });

  app.get("/s/:token/fonts.css", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    return c.body(fontFaceCss(await listFonts(found.ws), `/s/${found.record.token}/fonts/`), 200, {
      "Content-Type": "text/css; charset=utf-8",
      ...noStore,
    });
  });

  app.get("/s/:token/fonts/:file", async (c) => {
    const found = await viewer(c);
    if (found instanceof Response) {
      return found;
    }
    const file = c.req.param("file");
    const bytes = isSafeFontFile(file) ? await readFontFile(found.ws, file) : null;
    if (!bytes) {
      return c.notFound();
    }
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": file.endsWith(".otf") ? "font/otf" : "font/ttf",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  // The viewer page itself: the built web app, which shows the design alone
  // for /s/<token> paths. (In dev, Vite serves it.)
  app.get("/s/:token", async (c) => {
    try {
      const html = await readFile(path.join(webDistDir, "index.html"), "utf8");
      return c.html(html, 200, noStore);
    } catch {
      return c.notFound();
    }
  });
}
