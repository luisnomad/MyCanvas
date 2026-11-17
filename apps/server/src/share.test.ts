import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Design } from "@mycanvas/shared";
// Type only: the app is imported after the environment is set up below.
import type { app as appInstance } from "./app";
import type { ShareNotice } from "./notify";

const OWNER = "owner@example.com";
const TOKEN = "test-agent-token-0123456789abcdef0123456789";
const AGENT = "/api/agent/v1";
let app: typeof appInstance;

function request(init: RequestInit & { json?: unknown; as?: "agent" | "editor" | "public"; cookie?: string } = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (init.as === "agent") {
    headers.set("authorization", `Bearer ${TOKEN}`);
  } else if (init.as === "public") {
    // A visitor on the public host with no Cloudflare Access session.
    headers.set("x-mycanvas-route", "public");
  } else {
    headers.set("x-mycanvas-route", "local");
  }
  if (init.cookie) {
    headers.set("cookie", init.cookie);
  }
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const { json: _json, as: _as, cookie: _cookie, ...rest } = init;
  return { ...rest, headers, body };
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DAwMDAAAAOAAH/4cMpFwAAAABJRU5ErkJggg==",
  "base64",
);

async function upload(name: string): Promise<string> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(TINY_PNG)], name, { type: "image/png" }));
  const res = await app.request(`${AGENT}/assets`, request({ method: "POST", body: form, as: "agent" }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { asset: string }).asset;
}

async function newDesign(): Promise<{ design: Design; used: string; unused: string }> {
  const res = await app.request(`${AGENT}/designs`, request({ method: "POST", as: "agent", json: { name: "Sponsor image", width: 1080, height: 1080 } }));
  const design = (await res.json()) as Design;
  const used = await upload("used.png");
  const unused = await upload("private.png");
  await app.request(`${AGENT}/designs/${design.id}/ops`, request({
    method: "POST",
    as: "agent",
    json: { ops: [{ op: "addLayer", layer: { type: "image", asset: used, x: 0, y: 0, width: 100 } }] },
  }));
  await app.request(`${AGENT}/designs/${design.id}/lock`, request({ method: "DELETE", as: "agent" }));
  return { design, used, unused };
}

async function share(id: string, body: unknown = {}): Promise<{ share: { token: string; path: string; hasPin: boolean } | null }> {
  const res = await app.request(`/api/designs/${id}/share`, request({ method: "PUT", json: body }));
  expect(res.status).toBe(200);
  return (await res.json()) as { share: { token: string; path: string; hasPin: boolean } };
}

function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "mycanvas-share-test-"));
  process.env.MYCANVAS_DATA_DIR = dataDir;
  process.env.MYCANVAS_WEB_DIST = path.join(dataDir, "no-web");
  process.env.MYCANVAS_LOCAL_USER = OWNER;
  process.env.MYCANVAS_AGENT_TOKEN = TOKEN;
  process.env.MYCANVAS_RENDERER = "off";
  ({ app } = await import("./app"));
});

describe("share links", () => {
  it("lets anyone with the link see the design and only its images, without signing in", async () => {
    const { design, used, unused } = await newDesign();
    expect(await (await app.request(`/api/designs/${design.id}/share`, request())).json()).toMatchObject({ share: null });
    const link = (await share(design.id)).share;
    expect(link?.path).toMatch(/^\/s\/[a-f0-9]{32}$/);
    expect(link?.hasPin).toBe(false);

    const res = await app.request(`${link?.path ?? ""}/design`, request({ as: "public" }));
    expect(res.status).toBe(200);
    const shown = ((await res.json()) as { design: Design }).design;
    expect(shown.id).toBe(design.id);
    expect(shown.pages[0]?.thumbnail).toBeUndefined();

    expect((await app.request(`${link?.path ?? ""}/assets/${used}`, request({ as: "public" }))).status).toBe(200);
    // Other uploads in the workspace stay private.
    expect((await app.request(`${link?.path ?? ""}/assets/${unused}`, request({ as: "public" }))).status).toBe(404);
    // The signed-in API is still closed to the visitor.
    expect((await app.request(`/api/designs/${design.id}`, request({ as: "public" }))).status).toBe(401);
    expect((await app.request(`/assets/${used}`, request({ as: "public" }))).status).toBe(401);
  });

  it("asks for the PIN, lets the right one in, and shuts everyone out when the PIN changes", async () => {
    const { design, used } = await newDesign();
    const link = (await share(design.id, { pin: "4821" })).share;
    const base = link?.path ?? "";
    expect(link?.hasPin).toBe(true);

    const locked = await app.request(`${base}/design`, request({ as: "public" }));
    expect(locked.status).toBe(401);
    expect(await locked.json()).toMatchObject({ pin: true });
    expect((await app.request(`${base}/assets/${used}`, request({ as: "public" }))).status).toBe(401);

    const wrong = await app.request(`${base}/unlock`, request({ method: "POST", as: "public", json: { pin: "1111" } }));
    expect(wrong.status).toBe(401);
    const right = await app.request(`${base}/unlock`, request({ method: "POST", as: "public", json: { pin: "4821" } }));
    expect(right.status).toBe(200);
    expect(right.headers.get("set-cookie")).toMatch(new RegExp(`Path=${base}`));
    expect(right.headers.get("set-cookie")).toMatch(/HttpOnly/);
    const cookie = cookieFrom(right);
    expect((await app.request(`${base}/design`, request({ as: "public", cookie }))).status).toBe(200);
    expect((await app.request(`${base}/assets/${used}`, request({ as: "public", cookie }))).status).toBe(200);

    // A new PIN: the old cookie no longer works, and the link stays the same.
    expect((await share(design.id, { pin: "9999" })).share?.path).toBe(base);
    expect((await app.request(`${base}/design`, request({ as: "public", cookie }))).status).toBe(401);
    // Removing the PIN opens the link again.
    expect((await share(design.id, { pin: null })).share?.hasPin).toBe(false);
    expect((await app.request(`${base}/design`, request({ as: "public" }))).status).toBe(200);
  });

  it("refuses bad PINs and brakes guessing", async () => {
    const { design } = await newDesign();
    expect((await app.request(`/api/designs/${design.id}/share`, request({ method: "PUT", json: { pin: "12" } }))).status).toBe(400);
    expect((await app.request(`/api/designs/${design.id}/share`, request({ method: "PUT", json: { pin: "abcd" } }))).status).toBe(400);
    const base = (await share(design.id, { pin: "2468" })).share?.path ?? "";
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      statuses.push((await app.request(`${base}/unlock`, request({ method: "POST", as: "public", json: { pin: `000${String(i)}` } }))).status);
    }
    expect(statuses.slice(0, 8).every((status) => status === 401)).toBe(true);
    expect(statuses[8]).toBe(429);
    // Even the right PIN waits out the brake.
    expect((await app.request(`${base}/unlock`, request({ method: "POST", as: "public", json: { pin: "2468" } }))).status).toBe(429);
  });

  it("throws a link away for a new one, and stops sharing", async () => {
    const { design } = await newDesign();
    const old = (await share(design.id)).share?.path ?? "";
    const fresh = (await share(design.id, { newLink: true })).share?.path ?? "";
    expect(fresh).not.toBe(old);
    expect((await app.request(`${old}/design`, request({ as: "public" }))).status).toBe(404);
    expect((await app.request(`${fresh}/design`, request({ as: "public" }))).status).toBe(200);

    expect((await app.request(`/api/designs/${design.id}/share`, request({ method: "DELETE" }))).status).toBe(200);
    expect((await app.request(`${fresh}/design`, request({ as: "public" }))).status).toBe(404);
    expect((await app.request("/s/not-a-token/design", request({ as: "public" }))).status).toBe(404);
  });

  it("stops the link when the design is deleted", async () => {
    const { design } = await newDesign();
    const base = (await share(design.id)).share?.path ?? "";
    expect((await app.request(`/api/designs/${design.id}`, request({ method: "DELETE" }))).status).toBe(200);
    expect((await app.request(`${base}/design`, request({ as: "public" }))).status).toBe(404);
  });

  it("expires links, can extend them, and tells the editor when the link was last viewed", async () => {
    const { design } = await newDesign();
    const shared = (await share(design.id, { expiresInDays: 7 })).share as unknown as { path: string; expiresAt: string; expired: boolean; lastViewedAt: string | null };
    expect(Date.parse(shared.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(shared.expired).toBe(false);
    expect(shared.lastViewedAt).toBeNull();
    expect((await app.request(`/api/designs/${design.id}/share`, request({ method: "PUT", json: { expiresInDays: 3 } }))).status).toBe(400);

    expect((await app.request(`${shared.path}/design`, request({ as: "public" }))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const seen = (await (await app.request(`/api/designs/${design.id}/share`, request())).json()) as { share: { lastViewedAt: string | null } };
    expect(seen.share.lastViewedAt).not.toBeNull();

    // Out of date: the link answers 410 everywhere, but the editor still sees it.
    const { saveShare } = await import("./shares");
    const record = await saveShare(OWNER, design.id, {});
    record.expiresAt = new Date(Date.now() - 1000).toISOString();
    const expired = await app.request(`${shared.path}/design`, request({ as: "public" }));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ expired: true });
    expect((await app.request(`${shared.path}/unlock`, request({ method: "POST", as: "public", json: { pin: "1234" } }))).status).toBe(410);
    const info = (await (await app.request(`/api/designs/${design.id}/share`, request())).json()) as { share: { expired: boolean } };
    expect(info.share.expired).toBe(true);

    // Extending it (or "never") opens the same link again.
    expect((await share(design.id, { expiresInDays: null })).share).toMatchObject({ path: shared.path, expiresAt: null, expired: false });
    expect((await app.request(`${shared.path}/design`, request({ as: "public" }))).status).toBe(200);
  });

  it("asks for approval: viewers approve or ask for changes with their name, tied to the revision they saw", async () => {
    const { design } = await newDesign();
    const base = (await share(design.id)).share?.path ?? "";
    const view = async () => (await (await app.request(`${base}/design`, request({ as: "public" }))).json()) as {
      design: Design;
      approval: { requested: boolean; revision: number; latest: { name: string; decision: string; comment: string; revision: number } | null };
    };
    const review = (json: unknown) => app.request(`${base}/review`, request({ method: "POST", as: "public", json }));

    // Not asked: no reviews accepted.
    expect((await view()).approval).toMatchObject({ requested: false, latest: null });
    let revision = (await view()).approval.revision;
    expect((await review({ name: "Teresa", decision: "approved", revision })).status).toBe(403);

    expect((await share(design.id, { approvalRequested: true })).share).toMatchObject({ approvalRequested: true, reviews: [] });
    expect((await app.request(`/api/designs/${design.id}/share`, request({ method: "PUT", json: { approvalRequested: "yes" } }))).status).toBe(400);
    expect((await view()).approval.requested).toBe(true);

    // A name is required, and changes need a comment.
    expect((await review({ name: " ", decision: "approved", revision })).status).toBe(400);
    expect((await review({ name: "Teresa", decision: "maybe", revision })).status).toBe(400);
    expect((await review({ name: "Teresa", decision: "changes", comment: "", revision })).status).toBe(400);

    const asked = await review({ name: "Teresa", decision: "changes", comment: "Bigger logo", revision });
    expect(asked.status).toBe(201);
    expect((await view()).approval.latest).toMatchObject({ name: "Teresa", decision: "changes", comment: "Bigger logo", revision });

    // The design changes: a review of the old version is refused, the new one is accepted.
    await app.request(`${AGENT}/designs/${design.id}/ops`, request({
      method: "POST",
      as: "agent",
      json: { ops: [{ op: "addLayer", layer: { type: "rect", x: 0, y: 0, width: 10, height: 10, fill: "#000000" } }] },
    }));
    await app.request(`${AGENT}/designs/${design.id}/lock`, request({ method: "DELETE", as: "agent" }));
    const stale = await review({ name: "Teresa", decision: "approved", revision, acknowledged: true, ackVersion: "1" });
    expect(stale.status).toBe(409);
    revision = (await view()).approval.revision;
    expect((await review({ name: "Teresa", decision: "approved", comment: "", revision, acknowledged: true, ackVersion: "1" })).status).toBe(201);

    // The editor sees the whole history; a new link keeps it.
    const info = (await (await app.request(`/api/designs/${design.id}/share`, request())).json()) as { share: { reviews: { decision: string; revision: number }[] } };
    expect(info.share.reviews.map((r) => r.decision)).toEqual(["changes", "approved"]);
    expect(info.share.reviews[1]?.revision).toBe(revision);
    expect((await share(design.id, { newLink: true })).share).toMatchObject({ approvalRequested: true });
    const fresh = (await (await app.request(`/api/designs/${design.id}/share`, request())).json()) as { share: { reviews: unknown[] } };
    expect(fresh.share.reviews).toHaveLength(2);
  });

  it("lets the agent create a link without a PIN, ask for approval and read the reviews back", async () => {
    const { design } = await newDesign();
    const agent = (init: RequestInit & { json?: unknown } = {}) => app.request(`${AGENT}/designs/${design.id}/share`, request({ ...init, as: "agent" }));
    expect((await (await agent()).json())).toMatchObject({ share: null, url: null });
    expect((await app.request(`${AGENT}/designs/${design.id}/share`, request({ method: "PUT", json: {} }))).status).toBe(401);

    process.env.MYCANVAS_PUBLIC_URL = "https://canvas.example.com/";
    try {
      const made = (await (await agent({ method: "PUT", json: { approvalRequested: true, expiresInDays: 30 } })).json()) as {
        share: { path: string; hasPin: boolean; approvalRequested: boolean };
        url: string;
      };
      expect(made.share).toMatchObject({ hasPin: false, approvalRequested: true });
      expect(made.url).toBe(`https://canvas.example.com${made.share.path}`);

      const revision = ((await (await app.request(`${made.share.path}/design`, request({ as: "public" }))).json()) as { approval: { revision: number } }).approval.revision;
      await app.request(`${made.share.path}/review`, request({ method: "POST", as: "public", json: { name: "Teresa", decision: "approved", comment: "OK", revision, acknowledged: true, ackVersion: "1" } }));
      const back = (await (await agent()).json()) as { share: { reviews: { name: string; decision: string }[] } };
      expect(back.share.reviews).toMatchObject([{ name: "Teresa", decision: "approved" }]);

      expect((await agent({ method: "PUT", json: { pin: "1" } })).status).toBe(400);
      expect((await (await agent({ method: "DELETE" })).json())).toMatchObject({ share: null });
    } finally {
      delete process.env.MYCANVAS_PUBLIC_URL;
    }
  });

  it("serves fonts CSS that points inside the link", async () => {
    const { design } = await newDesign();
    const base = (await share(design.id)).share?.path ?? "";
    const css = await app.request(`${base}/fonts.css`, request({ as: "public" }));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    expect((await app.request(`${base}/fonts.json`, request({ as: "public" }))).status).toBe(200);
  });
});

// ── Sign-off, download proof, language and notifications ─────────────────

interface ViewApproval {
  requested: boolean;
  revision: number;
  language: string;
  latest: Record<string, unknown> | null;
  acknowledgement: { version: string; text: string };
  downloadable: boolean;
}

interface Download {
  name: string;
  token: string;
  revision: number;
  sha256: string;
  bytes: number;
  ip: string | null;
  forwardedFor: string | null;
  userAgent: string | null;
  acknowledgement: { version: string; language: string; text: string };
}

describe("approval sign-off and approved PDF downloads", () => {
  const notices: ShareNotice[] = [];
  let exports = 0;

  beforeAll(async () => {
    const { setSharePdfExporter } = await import("./share-routes");
    setSharePdfExporter((_ws, design) => {
      exports += 1;
      return Promise.resolve(Buffer.from(`%PDF-1.7 fake ${design.id} r${String(design.revision ?? 0)}`));
    });
    const { setNotifyTransports } = await import("./notify");
    setNotifyTransports([{ name: "mock", send: (notice) => { notices.push(notice); return Promise.resolve(); } }]);
  });

  afterEach(() => {
    notices.length = 0;
  });

  async function approvalLink() {
    const { design } = await newDesign();
    const base = (await share(design.id, { approvalRequested: true })).share?.path ?? "";
    const view = async () => ((await (await app.request(`${base}/design`, request({ as: "public" }))).json()) as { approval: ViewApproval }).approval;
    const post = (what: "review" | "download", json: unknown, headers: Record<string, string> = {}) =>
      app.request(`${base}/${what}`, request({ method: "POST", as: "public", json, headers }));
    const edit = async () => {
      await app.request(`${AGENT}/designs/${design.id}/ops`, request({
        method: "POST",
        as: "agent",
        json: { ops: [{ op: "addLayer", layer: { type: "rect", x: 0, y: 0, width: 10, height: 10, fill: "#000000" } }] },
      }));
      await app.request(`${AGENT}/designs/${design.id}/lock`, request({ method: "DELETE", as: "agent" }));
    };
    const state = async () => (await (await app.request(`${AGENT}/designs/${design.id}/share`, request({ as: "agent" }))).json()) as {
      share: { language: string; reviews: { name: string; decision: string; acknowledgement?: { text: string }; ip?: string }[] };
      downloads: Download[];
    };
    return { design, base, view, post, edit, state };
  }

  const ack = { acknowledged: true, ackVersion: "1" };

  it("needs the sign-off box ticked to approve, and records the exact text shown", async () => {
    const { view, post, state } = await approvalLink();
    const approval = await view();
    expect(approval.language).toBe("es");
    expect(approval.acknowledgement.version).toBe("1");
    expect(approval.acknowledgement.text).toBe(
      `Al aprobar y descargar, confirmo mi conformidad con este diseño en su versión ${String(approval.revision)} y acepto que se considera entregado.`,
    );
    const revision = approval.revision;

    const unticked = await post("review", { name: "Ana", decision: "approved", revision });
    expect(unticked.status).toBe(400);
    expect(await unticked.json()).toMatchObject({ code: "acknowledgement" });
    expect((await post("review", { name: "Ana", decision: "approved", revision, acknowledged: true, ackVersion: "0" })).status).toBe(400);
    // Asking for changes is not a sign-off: no box needed.
    expect((await post("review", { name: "Ana", decision: "changes", comment: "Logo", revision })).status).toBe(201);

    const ok = await post("review", { name: "Ana", decision: "approved", revision, ...ack }, { "user-agent": "TestPhone/1.0", "cf-connecting-ip": "203.0.113.7" });
    expect(ok.status).toBe(201);
    const reviews = (await state()).share.reviews;
    expect(reviews.at(-1)).toMatchObject({ name: "Ana", decision: "approved", ip: "203.0.113.7", acknowledgement: { text: approval.acknowledgement.text } });
    // Viewers see the answer, never where it came from.
    const latest = (await view()).latest ?? {};
    expect(latest).toMatchObject({ name: "Ana", decision: "approved" });
    expect(latest).not.toHaveProperty("ip");
    expect(latest).not.toHaveProperty("acknowledgement");
  });

  it("blocks the download before approval, without the box, and for stale or unapproved revisions", async () => {
    const { view, post, edit } = await approvalLink();
    let revision = (await view()).revision;
    expect((await view()).downloadable).toBe(false);

    const early = await post("download", { name: "Ana", revision, ...ack });
    expect(early.status).toBe(403);
    expect(await early.json()).toMatchObject({ code: "not-approved" });
    await post("review", { name: "Ana", decision: "changes", comment: "Logo", revision });
    expect((await post("download", { name: "Ana", revision, ...ack })).status).toBe(403);

    expect((await post("review", { name: "Ana", decision: "approved", revision, ...ack })).status).toBe(201);
    expect((await view()).downloadable).toBe(true);
    expect((await post("download", { name: "Ana", revision })).status).toBe(400);
    expect((await post("download", { name: "", revision, ...ack })).status).toBe(400);
    expect((await post("download", { name: "Ana", revision, ...ack })).status).toBe(200);

    // A later edit: the old revision is stale, the new one isn't approved yet.
    await edit();
    expect((await post("download", { name: "Ana", revision, ...ack })).status).toBe(409);
    revision = (await view()).revision;
    expect((await view()).downloadable).toBe(false);
    expect((await post("download", { name: "Ana", revision, ...ack })).status).toBe(403);
  });

  it("logs every download as proof: name, sign-off text, revision, SHA-256, IP, user agent and token", async () => {
    const { design, base, view, post, state } = await approvalLink();
    const { revision, acknowledgement } = await view();
    await post("review", { name: "Ana", decision: "approved", revision, ...ack });
    const before = exports;
    const headers = { "user-agent": "TestPhone/1.0", "x-forwarded-for": "198.51.100.4, 10.0.0.2", "x-real-ip": "10.0.0.2" };
    const res = await post("download", { name: "Ana López", revision, ...ack }, headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename=".+ v\d+\.pdf"; filename\*=UTF-8''/);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(res.headers.get("x-mycanvas-sha256")).toBe(sha);

    // Re-downloads are allowed, logged each time, and serve the very same file.
    const again = await post("download", { name: "Ana López", revision, ...ack }, headers);
    expect(again.headers.get("x-mycanvas-sha256")).toBe(sha);
    expect(exports - before).toBe(1);

    const { downloads } = await state();
    expect(downloads).toHaveLength(2);
    expect(downloads[0]).toMatchObject({
      kind: "download",
      name: "Ana López",
      token: base.slice(3),
      revision,
      sha256: sha,
      bytes: bytes.length,
      ip: "198.51.100.4",
      forwardedFor: "198.51.100.4, 10.0.0.2",
      realIp: "10.0.0.2",
      userAgent: "TestPhone/1.0",
      acknowledgement: { version: "1", language: "es", text: acknowledgement.text },
    });
    expect(downloads[0]).not.toHaveProperty("owner");
    expect(Date.parse((downloads[0] as unknown as { at: string }).at)).toBeGreaterThan(0);

    // The proof stays after the link is thrown away or stopped.
    await share(design.id, { newLink: true });
    await app.request(`/api/designs/${design.id}/share`, request({ method: "DELETE" }));
    expect((await state()).downloads).toHaveLength(2);
  });

  it("keeps one approval when the same person approves the same revision again", async () => {
    const { view, post, state } = await approvalLink();
    const { revision } = await view();
    expect((await post("review", { name: "Teresa", decision: "approved", revision, ...ack })).status).toBe(201);
    const repeat = await post("review", { name: " teresa ", decision: "approved", revision, ...ack });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ repeat: true });
    expect((await post("review", { name: "Teresa", decision: "approved", revision, ...ack })).status).toBe(200);
    expect((await state()).share.reviews).toHaveLength(1);
    // Someone else's approval still counts.
    expect((await post("review", { name: "Luis", decision: "approved", revision, ...ack })).status).toBe(201);
    expect((await state()).share.reviews).toHaveLength(2);
  });

  it("shows repeated approvals stored by older links as one, without rewriting them", async () => {
    const { design } = await newDesign();
    const { saveShare, shareInfo } = await import("./shares");
    const record = await saveShare(OWNER, design.id, { approvalRequested: true });
    const old = (id: string, at: string) => ({ id, name: "Teresa", decision: "approved" as const, comment: "", at, revision: 4 });
    record.reviews = [old("a", "2026-11-16T10:00:00Z"), old("b", "2026-11-16T10:00:05Z"), old("c", "2026-11-16T10:00:09Z")];
    expect(shareInfo(record).reviews.map((r) => r.id)).toEqual(["a"]);
    expect(record.reviews).toHaveLength(3);
    // A record without `language` (made before it existed) reads as Spanish.
    expect(shareInfo({ ...record, language: undefined }).language).toBe("es");
  });

  it("has a per-link language, Spanish by default", async () => {
    const { design, view, state } = await approvalLink();
    expect((await state()).share.language).toBe("es");
    expect((await app.request(`${AGENT}/designs/${design.id}/share`, request({ method: "PUT", as: "agent", json: { language: "fr" } }))).status).toBe(400);
    expect((await (await app.request(`${AGENT}/designs/${design.id}/share`, request({ method: "PUT", as: "agent", json: { language: "en" } }))).json())).toMatchObject({ share: { language: "en" } });
    const approval = await view();
    expect(approval.language).toBe("en");
    expect(approval.acknowledgement.text).toMatch(/^By approving and downloading/);
    const pinned = (await share(design.id, { pin: "5555" })).share?.path ?? "";
    expect(await (await app.request(`${pinned}/design`, request({ as: "public" }))).json()).toMatchObject({ pin: true, language: "en" });
  });

  it("notifies on approval, change request and download (not on a repeat)", async () => {
    const { design, view, post } = await approvalLink();
    const { revision } = await view();
    await post("review", { name: "Ana", decision: "changes", comment: "Bigger logo", revision });
    await post("review", { name: "Ana", decision: "approved", revision, ...ack });
    await post("review", { name: "Ana", decision: "approved", revision, ...ack });
    await post("download", { name: "Ana", revision, ...ack });
    expect(notices.map((n) => n.kind)).toEqual(["changes", "approved", "downloaded"]);
    expect(notices[0]).toMatchObject({ designId: design.id, designName: "Sponsor image", reviewer: "Ana", revision, comment: "Bigger logo" });
    expect(notices[2]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("notifier", () => {
  const env = {
    NOTIFY_TELEGRAM_BOT_TOKEN: "123456:SECRET-bot-token",
    NOTIFY_TELEGRAM_CHAT_ID: "42",
    NOTIFY_WEBHOOK_URL: "https://ntfy.example.com/",
    NOTIFY_WEBHOOK_TOPIC: "mycanvas",
    MYCANVAS_EDITOR_URL: "https://canva.local/",
  };
  const notice: ShareNotice = { kind: "downloaded", designId: "abc123", designName: "Playbook", reviewer: "Ana", revision: 7, sha256: "f".repeat(64) };

  it("posts to Telegram and the webhook with the design, reviewer, revision and editor link", async () => {
    const { transportsFromEnv, noticeMessage } = await import("./notify");
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fake = (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const transports = transportsFromEnv(env, fake);
    expect(transports.map((t) => t.name)).toEqual(["telegram", "webhook"]);
    const message = noticeMessage(notice, env);
    expect(message.text).toContain("Ana downloaded the approved PDF of \"Playbook\"");
    expect(message.text).toContain("Revision 7");
    expect(message.editorUrl).toBe("https://canva.local/#/edit/abc123");
    for (const transport of transports) {
      await transport.send(notice, message, new AbortController().signal);
    }
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123456:SECRET-bot-token/sendMessage");
    expect(calls[0]?.body).toMatchObject({ chat_id: "42", text: message.text });
    expect(calls[1]?.body).toMatchObject({ topic: "mycanvas", event: "share.downloaded", reviewer: "Ana", revision: 7, editorUrl: message.editorUrl });
    expect(transportsFromEnv({}, fake)).toEqual([]);
  });

  it("never throws and keeps secrets out of the log", async () => {
    const { notify, redact, setNotifyTransports } = await import("./notify");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setNotifyTransports([{ name: "broken", send: () => Promise.reject(new Error(`fetch https://api.telegram.org/bot${env.NOTIFY_TELEGRAM_BOT_TOKEN}/sendMessage failed`)) }]);
    const saved = process.env.NOTIFY_TELEGRAM_BOT_TOKEN;
    process.env.NOTIFY_TELEGRAM_BOT_TOKEN = env.NOTIFY_TELEGRAM_BOT_TOKEN;
    try {
      await expect(notify(notice)).resolves.toBeUndefined();
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("notify (broken) failed");
      expect(logged).not.toContain("SECRET");
      expect(redact("x SECRET y", { NOTIFY_WEBHOOK_TOKEN: "SECRET" })).toBe("x [redacted] y");
    } finally {
      if (saved === undefined) {
        delete process.env.NOTIFY_TELEGRAM_BOT_TOKEN;
      } else {
        process.env.NOTIFY_TELEGRAM_BOT_TOKEN = saved;
      }
      setNotifyTransports(null);
      warn.mockRestore();
    }
  });
});
