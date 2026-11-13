import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Design } from "@mycanvas/shared";
// Type only: the app is imported after the environment is set up below.
import type { app as appInstance } from "./app";

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

  it("serves fonts CSS that points inside the link", async () => {
    const { design } = await newDesign();
    const base = (await share(design.id)).share?.path ?? "";
    const css = await app.request(`${base}/fonts.css`, request({ as: "public" }));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    expect((await app.request(`${base}/fonts.json`, request({ as: "public" }))).status).toBe(200);
  });
});
