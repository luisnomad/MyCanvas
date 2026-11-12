import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Design } from "@mycanvas/shared";
// Type only: the modules are imported after the environment is set up below.
import type { app as appInstance } from "../app";
import type * as LocksModule from "../locks";

const OWNER = "owner@example.com";
const TOKEN = "test-agent-token-0123456789abcdef0123456789";

let app: typeof appInstance;
let locks: typeof LocksModule;

/** A real (tiny) PNG of the given size. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) {
      c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function agent(init: RequestInit & { json?: unknown } = {}, token: string | null = TOKEN): RequestInit {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const { json: _json, ...rest } = init;
  return { ...rest, headers, body };
}

/** The editor as the local owner (canva.local route). */
function editor(init: RequestInit & { json?: unknown } = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("x-mycanvas-route", "local");
  headers.set("x-mycanvas-client", "tab-1");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const { json: _json, ...rest } = init;
  return { ...rest, headers, body };
}

const BASE = "/api/agent/v1";

async function newDesign(name = "Agent design"): Promise<Design> {
  const res = await app.request(`${BASE}/designs`, agent({ method: "POST", json: { name, width: 1200, height: 628, background: "#0d1b2a" } }));
  expect(res.status).toBe(201);
  return (await res.json()) as Design;
}

async function ops(id: string, list: unknown[], extra: Record<string, unknown> = {}): Promise<Response> {
  return app.request(`${BASE}/designs/${id}/ops`, agent({ method: "POST", json: { ops: list, ...extra } }));
}

async function getDesign(id: string): Promise<Design> {
  return (await (await app.request(`${BASE}/designs/${id}`, agent())).json()) as Design;
}

async function upload(width: number, height: number, name = "logo.png", folderId?: string): Promise<{ asset: string; width: number; height: number; folderId?: string }> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(png(width, height))], name, { type: "image/png" }));
  if (folderId) {
    form.set("folderId", folderId);
  }
  const res = await app.request(`${BASE}/assets`, agent({ method: "POST", body: form }));
  expect(res.status).toBe(201);
  return (await res.json()) as { asset: string; width: number; height: number; folderId?: string };
}

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "mycanvas-agent-test-"));
  process.env.MYCANVAS_DATA_DIR = dataDir;
  process.env.MYCANVAS_WEB_DIST = path.join(dataDir, "no-web");
  process.env.MYCANVAS_LOCAL_USER = OWNER;
  process.env.MYCANVAS_AGENT_TOKEN = TOKEN;
  // No Chromium in unit tests (render endpoints are checked against a dev server).
  process.env.MYCANVAS_RENDERER = "off";
  ({ app } = await import("../app"));
  locks = await import("../locks");
});

afterAll(() => {
  vi.useRealTimers();
});

describe("agent auth", () => {
  it("needs the token", async () => {
    expect((await app.request(`${BASE}/designs`, agent({}, null))).status).toBe(401);
    expect((await app.request(`${BASE}/designs`, agent({}, "wrong-token"))).status).toBe(401);
    expect((await app.request(`${BASE}/designs`, agent())).status).toBe(200);
  });

  it("is refused on the public route even with the token", async () => {
    const res = await app.request(`${BASE}/designs`, agent({ headers: { "x-mycanvas-route": "public", "cf-access-jwt-assertion": "x" } }));
    // Without a valid Access JWT the public route stops it first; with one, the agent guard does.
    expect([401, 403]).toContain(res.status);
    const noJwt = await app.request(`${BASE}/designs`, agent({ headers: { "x-mycanvas-route": "public" } }));
    expect(noJwt.status).toBe(401);
  });

  it("is off when no token is configured", async () => {
    const saved = process.env.MYCANVAS_AGENT_TOKEN;
    process.env.MYCANVAS_AGENT_TOKEN = "";
    try {
      expect((await app.request(`${BASE}/designs`, agent())).status).toBe(404);
    } finally {
      process.env.MYCANVAS_AGENT_TOKEN = saved;
    }
  });

  it("works in the owner's workspace (the editor sees agent designs)", async () => {
    const design = await newDesign("Shared with the editor");
    const res = await app.request(`/api/designs/${design.id}`, editor());
    expect(res.status).toBe(200);
  });
});

describe("designs and ops", () => {
  it("creates a design locked to Claude, at revision 1", async () => {
    const design = await newDesign();
    expect(design.revision).toBe(1);
    const lock: unknown = await (await app.request(`${BASE}/designs/${design.id}/lock`, agent())).json();
    expect(lock).toMatchObject({ holder: "agent", label: "Claude", email: OWNER });
  });

  it("adds, updates, moves and deletes layers in one atomic batch", async () => {
    const design = await newDesign();
    const res = await ops(design.id, [
      { op: "updatePage", page: 0, background: "#112233" },
      { op: "addLayer", layer: { type: "rect", id: "panel", x: 40, y: 40, width: 400, height: 200, fill: "#ff8800" } },
      { op: "addLayer", layer: { type: "text", id: "headline", text: "Hola Bonilista", x: 60, y: 80, fontFamily: "Montserrat", fontSize: 72, fontStyle: "800", fill: "#ffffff", wrapWidth: 900 } },
      { op: "addLayer", layer: { type: "shape", shape: "star", x: 900, y: 40, width: 120, height: 120 }, at: "bottom" },
      { op: "updateLayer", id: "headline", set: { effect: { type: "shadow", distance: 4 } } },
      { op: "moveLayer", id: "panel", to: { above: "headline" } },
    ]);
    expect(res.status).toBe(200);
    const result = (await res.json()) as { revision: number; created: string[] };
    expect(result.revision).toBe(2);
    expect(result.created.slice(0, 2)).toEqual(["panel", "headline"]);
    const stored = await getDesign(design.id);
    const page = stored.pages[0];
    expect(page?.background).toBe("#112233");
    expect(page?.layers.map((layer) => layer.type)).toEqual(["shape", "text", "rect"]);
    const headline = page?.layers.find((layer) => layer.id === "headline");
    expect(headline).toMatchObject({ type: "text", name: "Hola Bonilista", fontStyle: "800", lineHeight: 1.2, scaleX: 1, visible: true });
    // Partial effect input gets the editor's curated defaults for the rest.
    expect(headline && "effect" in headline ? headline.effect : null).toMatchObject({ type: "shadow", distance: 4, color: "#000000", blur: 12 });
  });

  it("rolls back the whole batch when one op is invalid, saying which", async () => {
    const design = await newDesign();
    const res = await ops(design.id, [
      { op: "addLayer", layer: { type: "rect", id: "ok" } },
      { op: "addLayer", layer: { type: "text", text: "x", fontSize: -3 } },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("ops[1].layer.fontSize");
    const stored = await getDesign(design.id);
    expect(stored.pages[0]?.layers).toEqual([]);
    expect(stored.revision).toBe(1);
  });

  it("refuses unknown fields, type changes and duplicate ids", async () => {
    const design = await newDesign();
    await ops(design.id, [{ op: "addLayer", layer: { type: "rect", id: "box" } }]);
    for (const [list, fragment] of [
      [[{ op: "addLayer", layer: { type: "rect", colour: "#fff" } }], "colour: unknown field"],
      [[{ op: "updateLayer", id: "box", set: { type: "text" } }], "type can't change"],
      [[{ op: "addLayer", layer: { type: "rect", id: "box" } }], "already used"],
      [[{ op: "updateLayer", id: "nope", set: { x: 1 } }], "no layer \"nope\""],
      [[{ op: "addLayer", layer: { type: "rect", fill: "orange-ish" } }], "fill: must be a color"],
      [[{ op: "explode" }], "ops[0].op"],
    ] as const) {
      const res = await ops(design.id, [...list]);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(fragment);
    }
  });

  it("places uploaded images: natural size, one side given, cover and contain fits", async () => {
    const design = await newDesign();
    const photo = await upload(400, 200, "photo.png");
    expect(photo).toMatchObject({ width: 400, height: 200 });
    const res = await ops(design.id, [
      { op: "addLayer", layer: { type: "image", id: "a", asset: photo.asset } },
      { op: "addLayer", layer: { type: "image", id: "b", asset: photo.asset, x: 0, y: 0, width: 100 } },
      { op: "addLayer", layer: { type: "image", id: "c", asset: photo.asset, x: 0, y: 0, width: 300, height: 300, fit: "cover" } },
      { op: "addLayer", layer: { type: "image", id: "d", asset: photo.asset, x: 0, y: 0, width: 300, height: 300, fit: "contain" } },
      { op: "addLayer", layer: { type: "frame", id: "e", shape: "circle", x: 0, y: 0, width: 200, height: 200, content: { asset: photo.asset } } },
    ]);
    expect(res.status).toBe(200);
    const layers = (await getDesign(design.id)).pages[0]?.layers ?? [];
    expect(layers[0]).toMatchObject({ width: 400, height: 200 });
    expect(layers[1]).toMatchObject({ width: 100, height: 50 });
    expect(layers[2]).toMatchObject({ width: 300, height: 300, crop: { x: 100, y: 0, width: 200, height: 200 } });
    expect(layers[3]).toMatchObject({ width: 300, height: 150, x: 0, y: 75 });
    expect(layers[4]).toMatchObject({ content: { asset: photo.asset, scale: 1, offsetX: -100, offsetY: 0 } });
    const missing = await ops(design.id, [{ op: "addLayer", layer: { type: "image", asset: "deadbeef.png" } }]);
    expect(missing.status).toBe(400);
  });

  it("adds, copies, moves and deletes pages", async () => {
    const design = await newDesign();
    await ops(design.id, [{ op: "addLayer", layer: { type: "rect", id: "r1" } }]);
    const res = await ops(design.id, [
      { op: "addPage", copyOf: 0 },
      { op: "addPage", background: "#000000" },
      { op: "movePage", page: 2, to: 0 },
    ]);
    expect(res.status).toBe(200);
    const stored = await getDesign(design.id);
    expect(stored.pages.map((page) => page.background)).toEqual(["#000000", "#0d1b2a", "#0d1b2a"]);
    expect(stored.pages[2]?.layers[0]?.id).not.toBe("r1");
    expect((await ops(design.id, [{ op: "deletePage", page: 0 }])).status).toBe(200);
    expect((await getDesign(design.id)).pages).toHaveLength(2);
  });

  it("duplicates a design as a variation locked to Claude", async () => {
    const design = await newDesign("Original");
    await ops(design.id, [{ op: "addLayer", layer: { type: "rect", id: "r" } }]);
    const res = await app.request(`${BASE}/designs/${design.id}/duplicate`, agent({ method: "POST", json: { name: "Variation B" } }));
    expect(res.status).toBe(201);
    const copy = (await res.json()) as Design;
    expect(copy).toMatchObject({ name: "Variation B", revision: 1 });
    expect(copy.pages[0]?.layers[0]?.id).toBe("r");
    expect(await locks.getLock(await workspace(), copy.id)).toMatchObject({ holder: "agent" });
  });

  it("checks baseRevision when given", async () => {
    const design = await newDesign();
    const stale = await ops(design.id, [{ op: "addLayer", layer: { type: "rect" } }], { baseRevision: 0 });
    expect(stale.status).toBe(409);
    expect((await ops(design.id, [{ op: "addLayer", layer: { type: "rect" } }], { baseRevision: 1 })).status).toBe(200);
  });
});

async function workspace() {
  const { workspaceFor } = await import("../storage");
  return workspaceFor(OWNER);
}

describe("locks", () => {
  it("keeps the editor view-only while Claude holds the lock", async () => {
    const design = await newDesign();
    const res = await app.request(`/api/designs/${design.id}`, editor({ method: "PUT", json: { name: "Luis edit" } }));
    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: "locked", lock: { holder: "agent" } });
    expect((await app.request(`/api/designs/${design.id}/lock`, editor({ method: "POST" }))).status).toBe(423);
  });

  it("lets Luis take over; Claude's next write gets lock_lost and can't take it back", async () => {
    const design = await newDesign();
    const taken = await app.request(`/api/designs/${design.id}/lock/takeover`, editor({ method: "POST" }));
    expect(await taken.json()).toMatchObject({ holder: "human", email: OWNER });
    const write = await ops(design.id, [{ op: "addLayer", layer: { type: "rect" } }]);
    expect(write.status).toBe(423);
    expect(await write.json()).toMatchObject({ error: "lock_lost", lock: { holder: "human" } });
    expect((await app.request(`${BASE}/designs/${design.id}/lock`, agent({ method: "POST" }))).status).toBe(423);
    // Luis edits freely now.
    expect((await app.request(`/api/designs/${design.id}`, editor({ method: "PUT", json: { name: "Mine now" } }))).status).toBe(200);
  });

  it("has no timeouts: locks last until released on purpose", async () => {
    vi.useFakeTimers();
    try {
      const design = await newDesign();
      vi.advanceTimersByTime(7 * 24 * 3600 * 1000);
      expect(await locks.getLock(await workspace(), design.id)).toMatchObject({ holder: "agent" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees the design when Claude releases at the end of its task", async () => {
    const design = await newDesign();
    const res = await app.request(`${BASE}/designs/${design.id}/lock`, agent({ method: "DELETE" }));
    expect(await res.json()).toMatchObject({ released: true });
    expect((await app.request(`/api/designs/${design.id}/lock`, editor({ method: "POST" }))).status).toBe(200);
    // Luis's lock: only he unlocks it, or Claude when he asks (release-human).
    const notMine = await app.request(`${BASE}/designs/${design.id}/lock`, agent({ method: "DELETE" }));
    expect(await notMine.json()).toMatchObject({ released: false });
    const released = await app.request(`${BASE}/designs/${design.id}/lock/release-human`, agent({ method: "POST" }));
    expect(await released.json()).toMatchObject({ released: true });
    expect((await ops(design.id, [{ op: "addLayer", layer: { type: "rect" } }])).status).toBe(200);
  });

  it("survives a server restart (stored on disk)", async () => {
    const design = await newDesign();
    locks.clearLockCache();
    expect(await locks.getLock(await workspace(), design.id)).toMatchObject({ holder: "agent" });
    const all = (await (await app.request("/api/locks", editor())).json()) as { designId: string }[];
    expect(all.some((lock) => lock.designId === design.id)).toBe(true);
  });

  it("drops the lock when Luis deletes the design", async () => {
    const design = await newDesign();
    expect((await app.request(`/api/designs/${design.id}`, editor({ method: "DELETE" }))).status).toBe(200);
    expect(await locks.getLock(await workspace(), design.id)).toBeNull();
  });
});

describe("revisions in the editor", () => {
  it("refuses a save from an older copy and accepts saves without baseRevision", async () => {
    const design = await newDesign();
    await app.request(`${BASE}/designs/${design.id}/lock`, agent({ method: "DELETE" }));
    const first = await app.request(`/api/designs/${design.id}`, editor({ method: "PUT", json: { name: "A", baseRevision: 1 } }));
    expect(((await first.json()) as Design).revision).toBe(2);
    const stale = await app.request(`/api/designs/${design.id}`, editor({ method: "PUT", json: { name: "B", baseRevision: 1 } }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale", revision: 2 });
    expect((await app.request(`/api/designs/${design.id}`, editor({ method: "PUT", json: { name: "C" } }))).status).toBe(200);
  });
});

describe("uploads", () => {
  it("files uploads in a folder and lists them by folder", async () => {
    const folder = await (await app.request(`${BASE}/asset-folders`, agent({ method: "POST", json: { name: "CEEI" } }))).json() as { id: string };
    const logo = await upload(64, 32, "ceei.png", folder.id);
    expect(logo.folderId).toBe(folder.id);
    const listed = (await (await app.request(`${BASE}/assets?folderId=${folder.id}`, agent())).json()) as { asset: string; name: string }[];
    expect(listed).toEqual([expect.objectContaining({ asset: logo.asset, name: "ceei.png" })]);
  });

  it("refuses files that aren't images", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "notes.txt"));
    expect((await app.request(`${BASE}/assets`, agent({ method: "POST", body: form }))).status).toBe(400);
    const fake = new FormData();
    fake.set("file", new File(["not a png"], "fake.png"));
    expect((await app.request(`${BASE}/assets`, agent({ method: "POST", body: fake }))).status).toBe(400);
  });
});

describe("event stream", () => {
  it("streams lock and design events to the editor", async () => {
    const res = await app.request("/api/events", editor());
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const read = async (until: string) => {
      while (!text.includes(until)) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        text += decoder.decode(value);
      }
    };
    await read("event: ready");
    const design = await newDesign("Streamed");
    await ops(design.id, [{ op: "addLayer", layer: { type: "rect" } }]);
    await read("design.updated");
    expect(text).toContain("event: design.created");
    expect(text).toContain("event: lock.changed");
    expect(text).toMatch(/event: design.updated\ndata: \{[^\n]*"by":"agent"/);
    await reader.cancel();
  });
});

describe("source files", () => {
  it("stores PDFs and Office files apart from Uploads, and serves them to the renderer", async () => {
    const form = new FormData();
    form.set("file", new File(["%PDF-1.7 test"], "example.pdf", { type: "application/pdf" }));
    const res = await app.request(`${BASE}/sources`, agent({ method: "POST", body: form }));
    expect(res.status).toBe(201);
    const source = (await res.json()) as { source: string; name: string };
    expect(source.name).toBe("example.pdf");
    const listed = (await (await app.request(`${BASE}/sources`, agent())).json()) as { source: string }[];
    expect(listed.map((entry) => entry.source)).toContain(source.source);
    const uploads = (await (await app.request(`${BASE}/assets`, agent())).json()) as { asset: string }[];
    expect(uploads.map((entry) => entry.asset)).not.toContain(source.source);
    const served = await app.request(`/api/sources/${source.source}`, editor());
    expect(served.headers.get("content-type")).toBe("application/pdf");
    expect(await served.text()).toBe("%PDF-1.7 test");
    expect((await app.request("/api/sources/..%2Fsecret.pdf", editor())).status).toBe(404);
  });

  it("refuses other file types", async () => {
    const form = new FormData();
    form.set("file", new File(["x"], "tool.exe"));
    expect((await app.request(`${BASE}/sources`, agent({ method: "POST", body: form }))).status).toBe(400);
  });

  it("checks document and import input before using the renderer", async () => {
    expect((await app.request(`${BASE}/documents`, agent({ method: "POST", json: { markdown: "# Hi" } }))).status).toBe(400);
    expect((await app.request(`${BASE}/documents`, agent({ method: "POST", json: { formatId: "nope", markdown: "# Hi" } }))).status).toBe(404);
    expect((await app.request(`${BASE}/content/import`, agent({ method: "POST", json: { source: "missing.pdf" } }))).status).toBe(404);
    expect((await app.request(`${BASE}/designs/nope/render`, agent())).status).toBe(404);
    const design = await newDesign();
    expect((await app.request(`${BASE}/designs/${design.id}/render?scale=9`, agent())).status).toBe(400);
  });
});
