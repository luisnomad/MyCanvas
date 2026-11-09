import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// Type only: the module is imported after the environment is set up below.
import type { app as appInstance } from "./app";

// Separate accounts: each person only ever sees their own workspace.
// Cloudflare Access is simulated with a local RSA key and a mocked JWKS.

const TEAM = "test-team.cloudflareaccess.com";
const AUD = "test-aud";
const OWNER = "owner@example.com";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const STRANGER = "stranger@example.com";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";

function jwt(payload: Record<string, unknown>, key = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function tokenFor(email: string, overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt({ aud: [AUD], iss: `https://${TEAM}`, email, iat: now, exp: now + 3600, ...overrides });
}

let app: typeof appInstance;
let dataDir: string;

function as(email: string | null, init: RequestInit = {}, route: "public" | null = "public"): RequestInit {
  const headers = new Headers(init.headers);
  if (route) {
    headers.set("x-mycanvas-route", route);
  }
  if (email) {
    headers.set("cf-access-jwt-assertion", tokenFor(email));
  }
  return { ...init, headers };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "mycanvas-test-"));
  process.env.MYCANVAS_DATA_DIR = dataDir;
  process.env.MYCANVAS_WEB_DIST = path.join(dataDir, "no-web");
  process.env.MYCANVAS_ACCESS_TEAM_DOMAIN = TEAM;
  process.env.MYCANVAS_ACCESS_AUD = AUD;
  process.env.MYCANVAS_LOCAL_USER = OWNER;
  process.env.MYCANVAS_ALLOWED_EMAILS = `${OWNER},${ALICE},${BOB}`;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] })));
  }));
  ({ app } = await import("./app"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("identity", () => {
  it("treats requests without the public route marker as the local owner", async () => {
    const res = await app.request("/api/me", as(null, {}, null));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: OWNER, via: "local", logoutUrl: null });
  });

  it("refuses public requests without a sign-in token", async () => {
    expect((await app.request("/api/designs", as(null))).status).toBe(401);
    expect((await app.request("/assets/abc.png", as(null))).status).toBe(401);
  });

  it("identifies a verified Access user", async () => {
    const res = await app.request("/api/me", as(ALICE));
    expect(await res.json()).toMatchObject({ email: ALICE, via: "access", logoutUrl: "/cdn-cgi/access/logout" });
  });

  it("rejects forged, foreign, expired and unknown-audience tokens", async () => {
    const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      jwt({ aud: [AUD], iss: `https://${TEAM}`, email: ALICE, exp: now + 3600 }, otherKey),
      tokenFor(ALICE, { aud: ["another-app"] }),
      tokenFor(ALICE, { iss: "https://evil.cloudflareaccess.com" }),
      tokenFor(ALICE, { exp: now - 10 }),
      "not-a-jwt",
    ];
    for (const token of bad) {
      const res = await app.request("/api/me", { headers: { "cf-access-jwt-assertion": token } });
      expect(res.status).toBe(401);
    }
  });

  it("rejects a valid token for an email that isn't allowed", async () => {
    expect((await app.request("/api/me", as(STRANGER))).status).toBe(403);
  });
});

describe("workspace isolation", () => {
  it("keeps designs private to their owner", async () => {
    const created = await app.request("/api/designs", as(ALICE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Client pitch" }),
    }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const aliceList = (await (await app.request("/api/designs", as(ALICE))).json()) as { id: string }[];
    expect(aliceList.map((design) => design.id)).toContain(id);

    const bobList = (await (await app.request("/api/designs", as(BOB))).json()) as unknown[];
    expect(bobList).toEqual([]);
    expect((await app.request(`/api/designs/${id}`, as(BOB))).status).toBe(404);
    expect((await app.request(`/api/designs/${id}`, as(BOB, { method: "DELETE" }))).status).toBe(404);
    expect((await app.request(`/api/designs/${id}`, as(ALICE))).status).toBe(200);
  });

  it("keeps uploads private, including direct image links", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "secret.png", { type: "image/png" }));
    const uploaded = await app.request("/api/assets", as(ALICE, { method: "POST", body: form }));
    expect(uploaded.status).toBe(201);
    const { asset } = (await uploaded.json()) as { asset: string };

    expect((await app.request(`/assets/${asset}`, as(ALICE))).status).toBe(200);
    expect((await app.request(`/assets/${asset}`, as(BOB))).status).toBe(404);
    expect((await (await app.request("/api/assets", as(BOB))).json()) as unknown[]).toEqual([]);
    expect((await app.request(`/api/assets/${asset}?force=1`, as(BOB, { method: "DELETE" }))).status).toBe(404);
    expect((await app.request(`/assets/${asset}`, as(ALICE))).status).toBe(200);
  });

  it("keeps saved templates private but shares the built-in starters", async () => {
    const created = await app.request("/api/designs", as(ALICE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Template source" }),
    }));
    const { id } = (await created.json()) as { id: string };
    await app.request("/api/templates", as(ALICE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ designId: id, name: "Alice brand" }),
    }));
    const names = async (email: string) =>
      ((await (await app.request("/api/templates", as(email))).json()) as { name: string; builtIn: boolean }[]);
    expect((await names(ALICE)).some((t) => t.name === "Alice brand")).toBe(true);
    const bobTemplates = await names(BOB);
    expect(bobTemplates.some((t) => t.name === "Alice brand")).toBe(false);
    expect(bobTemplates.every((t) => t.builtIn)).toBe(true);
    expect(bobTemplates.length).toBeGreaterThan(0);
  });
});

describe("project folders", () => {
  const json = (email: string, method: string, body: unknown): RequestInit =>
    as(email, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("creates private folders, files designs and keeps them filed across editor saves", async () => {
    const folderRes = await app.request("/api/folders", json(ALICE, "POST", { name: "Acme Corp" }));
    expect(folderRes.status).toBe(201);
    const folder = (await folderRes.json()) as { id: string; name: string };
    expect((await app.request("/api/folders", json(ALICE, "POST", { name: "acme corp" }))).status).toBe(409);
    expect((await app.request("/api/folders", json(ALICE, "POST", { name: "  " }))).status).toBe(400);

    // Folders are per person.
    expect((await (await app.request("/api/folders", as(BOB))).json()) as unknown[]).toEqual([]);
    expect((await app.request(`/api/folders/${folder.id}`, json(BOB, "PATCH", { name: "Mine" }))).status).toBe(404);

    // Created straight into the folder; Bob can't file into Alice's folder.
    const inFolder = (await (await app.request("/api/designs", json(ALICE, "POST", { name: "Acme banner", folderId: folder.id }))).json()) as { id: string; folderId?: string };
    expect(inFolder.folderId).toBe(folder.id);
    const bobDesign = (await (await app.request("/api/designs", json(BOB, "POST", { name: "Bob's", folderId: folder.id }))).json()) as { folderId?: string };
    expect(bobDesign.folderId).toBeUndefined();

    // An editor save carrying a stale folder can't undo a move.
    const loose = (await (await app.request("/api/designs", json(ALICE, "POST", { name: "Loose" }))).json()) as { id: string };
    const moved = await app.request(`/api/designs/${loose.id}/move`, json(ALICE, "POST", { folderId: folder.id }));
    expect(((await moved.json()) as { folderId?: string }).folderId).toBe(folder.id);
    await app.request(`/api/designs/${loose.id}`, json(ALICE, "PUT", { name: "Loose (edited)", folderId: undefined }));
    const after = (await (await app.request(`/api/designs/${loose.id}`, as(ALICE))).json()) as { name: string; folderId?: string };
    expect(after).toMatchObject({ name: "Loose (edited)", folderId: folder.id });

    // Moving to a folder that isn't yours fails; moving to null unfiles.
    expect((await app.request(`/api/designs/${loose.id}/move`, json(BOB, "POST", { folderId: null }))).status).toBe(404);
    expect((await app.request(`/api/designs/${loose.id}/move`, json(ALICE, "POST", { folderId: "nope" }))).status).toBe(404);

    // Rename, then delete: designs survive, unfiled.
    expect((await app.request(`/api/folders/${folder.id}`, json(ALICE, "PATCH", { name: "Acme Inc" }))).status).toBe(200);
    const deleted = (await (await app.request(`/api/folders/${folder.id}`, as(ALICE, { method: "DELETE" }))).json()) as { unfiled: number };
    expect(deleted.unfiled).toBe(2);
    const list = (await (await app.request("/api/designs", as(ALICE))).json()) as { id: string; folderId?: string }[];
    expect(list.find((design) => design.id === inFolder.id)?.folderId).toBeUndefined();
    expect(list.find((design) => design.id === loose.id)?.folderId).toBeUndefined();
  });
});

describe("multi-page designs", () => {
  const json = (email: string, method: string, body: unknown): RequestInit =>
    as(email, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("opens single-page files from before multi-page support as one page", async () => {
    const dir = path.join(dataDir, "users", "alice-example-com", "designs");
    await writeFile(path.join(dir, "legacy01.json"), JSON.stringify({
      id: "legacy01", name: "Old one", width: 100, height: 100, background: "#ff0000",
      layers: [{ id: "l1", type: "rect", name: "R", x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true,
        width: 10, height: 10, fill: "#000", cornerRadius: 0, stroke: { enabled: false, color: "#000", width: 1 },
        shadow: { enabled: false, color: "#000", blur: 0, offsetX: 0, offsetY: 0, opacity: 1 } }],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const design = (await (await app.request("/api/designs/legacy01", as(ALICE))).json()) as Record<string, unknown> & { pages: { background: string; layers: unknown[] }[] };
    expect(design.pages).toHaveLength(1);
    expect(design.pages[0]).toMatchObject({ background: "#ff0000" });
    expect(design.pages[0]?.layers).toHaveLength(1);
    expect(design.layers).toBeUndefined();
    const summary = ((await (await app.request("/api/designs", as(ALICE))).json()) as { id: string; pageCount: number }[])
      .find((entry) => entry.id === "legacy01");
    expect(summary?.pageCount).toBe(1);
  });

  it("saves pages, never drops them, and tracks image use on every page", async () => {
    const { id } = (await (await app.request("/api/designs", json(ALICE, "POST", { name: "Deck" }))).json()) as { id: string };
    const image = (asset: string) => ({ id: `img-${asset}`, type: "image", name: "i", x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
      visible: true, asset, width: 10, height: 10, shadow: { enabled: false, color: "#000", blur: 0, offsetX: 0, offsetY: 0, opacity: 1 } });
    const pages = [
      { id: "p1", background: "#fff", layers: [] },
      { id: "p2", background: "#000", layers: [image("aaaaaaaaaaaaaaaa.png")] },
    ];
    expect((await app.request(`/api/designs/${id}`, json(ALICE, "PUT", { pages }))).status).toBe(200);
    // A save without pages (or with none) keeps the stored ones.
    await app.request(`/api/designs/${id}`, json(ALICE, "PUT", { name: "Deck v2", pages: [] }));
    const saved = (await (await app.request(`/api/designs/${id}`, as(ALICE))).json()) as { name: string; pages: unknown[] };
    expect(saved.name).toBe("Deck v2");
    expect(saved.pages).toHaveLength(2);
    // Upload usage sees the image on page 2.
    await mkdir(path.join(dataDir, "users", "alice-example-com", "assets"), { recursive: true });
    await writeFile(path.join(dataDir, "users", "alice-example-com", "assets", "aaaaaaaaaaaaaaaa.png"), "x");
    const assets = (await (await app.request("/api/assets", as(ALICE))).json()) as { asset: string; usedIn: { id: string }[] }[];
    expect(assets.find((entry) => entry.asset === "aaaaaaaaaaaaaaaa.png")?.usedIn.map((use) => use.id)).toContain(id);
  });
});

describe("legacy data migration", () => {
  it("moves pre-workspace data into the owner's workspace once", async () => {
    const legacyDir = await mkdtemp(path.join(tmpdir(), "mycanvas-legacy-"));
    await mkdir(path.join(legacyDir, "designs"));
    await writeFile(path.join(legacyDir, "designs", "old.json"), "{}");
    await writeFile(path.join(legacyDir, "assets.json"), "{}");
    const storage = await import("./storage");
    // storage reads MYCANVAS_DATA_DIR at import; exercise the same logic on a fresh dir.
    const moved = await storage.migrateLegacyDataIn(legacyDir, OWNER);
    expect(moved).toEqual(["designs", "assets.json"]);
    expect(existsSync(path.join(legacyDir, "users", "owner-example-com", "designs", "old.json"))).toBe(true);
    expect(existsSync(path.join(legacyDir, "designs"))).toBe(false);
    expect(await storage.migrateLegacyDataIn(legacyDir, OWNER)).toEqual([]);
  });
});
