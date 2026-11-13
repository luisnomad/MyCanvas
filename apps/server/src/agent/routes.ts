import { timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { type Context, type Hono } from "hono";
import { type Design, type DesignSummary } from "@mycanvas/shared";

import type { AppEnv } from "../app";
import { registerAssetFolderRoutes, placeAssets } from "../asset-folders";
import { saveAsset } from "../assets-store";
import { LOCAL_USER } from "../auth";
import {
  type CreateDesignInput,
  createDesign,
  duplicateDesign,
  existingFolderId,
  readDesign,
  readFolders,
  readStored,
  toSummary,
  writeDesign,
} from "../designs";
import { eventStream, publish } from "../events";
import { registerFontRoutes } from "../font-routes";
import { imageSize } from "../image-size";
import { type DesignLock, acquireLock, getLock, releaseLock, serialized, wasTakenFromAgent } from "../locks";
import { isSafeId, newId, workspaceFor } from "../storage";
import { OpError, applyOps, assetsIn } from "./ops";
import { registerRenderRoutes, scheduleThumbnails } from "./render-routes";

/*
 * The agent API (docs/AGENT_API.md): Claude creates and edits designs in the
 * owner's workspace. Needs MYCANVAS_AGENT_TOKEN (unset = API off), and is
 * refused on the public route even with the token.
 */

export const AGENT_BASE = "/api/agent/v1";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

function agentToken(): string {
  return process.env.MYCANVAS_AGENT_TOKEN?.trim() ?? "";
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function agentLabel(c: Context): string {
  const label = c.req.header("x-mycanvas-agent")?.trim();
  return label !== undefined && label !== "" ? label.slice(0, 40) : "Claude";
}

function withoutThumbnails(design: Design): Design {
  const { thumbnail: _thumbnail, ...rest } = design;
  return { ...rest, pages: design.pages.map(({ thumbnail: _pageThumbnail, ...page }) => page) };
}

function lockedResponse(c: Context, lock: DesignLock, lost: boolean): Response {
  return c.json(
    {
      error: lost ? "lock_lost" : "locked",
      message: lost
        ? `${lock.label} took this design over. Stop and report; don't write until it is unlocked.`
        : `${lock.label} is editing this design. Wait for it to be unlocked, or ask them.`,
      lock,
    },
    423,
  );
}

interface AgentHelpers {
  isSafeAssetFile: (file: string) => boolean;
  listAssets: (c: Context<AppEnv>) => Promise<Response>;
}

export function registerAgentRoutes(app: Hono<AppEnv>, helpers: AgentHelpers): void {
  app.use(`${AGENT_BASE}/*`, async (c, next) => {
    const expected = agentToken();
    if (expected === "") {
      return c.json({ error: "The agent API is off (MYCANVAS_AGENT_TOKEN is not set)" }, 404);
    }
    if (c.req.header("x-mycanvas-route") === "public") {
      return c.json({ error: "The agent API is only available on the local network" }, 403);
    }
    const given = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim() ?? "";
    if (!tokenMatches(given, expected)) {
      return c.json({ error: "Agent token missing or wrong" }, 401);
    }
    // Claude works in the owner's workspace.
    c.set("ws", await workspaceFor(LOCAL_USER));
    await next();
  });

  /** Lock for Claude, or the 423 response explaining who has it. */
  async function lockForAgent(c: Context<AppEnv>, id: string): Promise<Response | null> {
    const result = await acquireLock(c.get("ws"), id, "agent", agentLabel(c));
    return result.ok ? null : lockedResponse(c, result.lock, false);
  }

  app.get(`${AGENT_BASE}/designs`, async (c) => {
    const ws = c.get("ws");
    const folderId = c.req.query("folderId");
    const q = c.req.query("q")?.trim().toLowerCase();
    const summaries: DesignSummary[] = [];
    for (const file of await readdir(ws.designsDir).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const design = await readStored(path.join(ws.designsDir, file));
      if (!design || (folderId !== undefined && design.folderId !== folderId) || (q && !design.name.toLowerCase().includes(q))) {
        continue;
      }
      const { thumbnail: _thumbnail, ...summary } = toSummary(design);
      summaries.push(summary);
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json(summaries);
  });

  app.get(`${AGENT_BASE}/designs/:id`, async (c) => {
    const design = await readDesign(c.get("ws"), c.req.param("id"));
    if (!design) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(c.req.query("thumbnails") === "1" ? design : withoutThumbnails(design));
  });

  app.post(`${AGENT_BASE}/designs`, async (c) => {
    const ws = c.get("ws");
    const body = await c.req.json<CreateDesignInput>().catch(() => null);
    if (!body) {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    const { pages: _pages, source: _source, blocks: _blocks, ...input } = body;
    const result = await createDesign(ws, input);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    await acquireLock(ws, result.design.id, "agent", agentLabel(c));
    publish(ws, { type: "design.created", id: result.design.id, folderId: result.design.folderId, by: "agent", clientId: null });
    scheduleThumbnails(ws, result.design.id);
    return c.json(withoutThumbnails(result.design), 201);
  });

  /** A variation: a copy of the design, locked to Claude. */
  app.post(`${AGENT_BASE}/designs/:id/duplicate`, async (c) => {
    const ws = c.get("ws");
    const source = await readDesign(ws, c.req.param("id"));
    if (!source) {
      return c.json({ error: "Not found" }, 404);
    }
    const body = await c.req.json<{ name?: string; folderId?: string | null }>().catch(() => ({}));
    const copy = await duplicateDesign(ws, source, body);
    await acquireLock(ws, copy.id, "agent", agentLabel(c));
    publish(ws, { type: "design.created", id: copy.id, folderId: copy.folderId, by: "agent", clientId: null });
    return c.json(withoutThumbnails(copy), 201);
  });

  /** Runs a write on a design under Claude's lock, as the next revision. */
  async function agentWrite(
    c: Context<AppEnv>,
    change: (design: Design) => Design | Response | Promise<Design | Response>,
    respond: (stored: Design) => unknown,
    baseRevision?: unknown,
  ): Promise<Response> {
    const ws = c.get("ws");
    const id = c.req.param("id") ?? "";
    return serialized(ws, id, async () => {
      const existing = await readDesign(ws, id);
      if (!existing) {
        return c.json({ error: "Not found" }, 404);
      }
      const current = await getLock(ws, id);
      if (current?.holder === "human") {
        return lockedResponse(c, current, wasTakenFromAgent(ws, id));
      }
      if (typeof baseRevision === "number" && baseRevision !== (existing.revision ?? 0)) {
        return c.json({ error: "stale", revision: existing.revision ?? 0 }, 409);
      }
      const denied = await lockForAgent(c, id);
      if (denied) {
        return denied;
      }
      const changed = await change(existing);
      if (changed instanceof Response) {
        return changed;
      }
      const stored = await writeDesign(ws, { ...changed, updatedAt: new Date().toISOString() }, existing);
      publish(ws, { type: "design.updated", id, revision: stored.revision ?? 0, by: "agent", clientId: null });
      scheduleThumbnails(ws, id);
      return c.json(respond(stored));
    });
  }

  app.patch(`${AGENT_BASE}/designs/:id`, async (c) => {
    const body = await c.req.json<{ name?: unknown; width?: unknown; height?: unknown }>().catch(() => null);
    if (!body) {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    const size = (value: unknown) => typeof value === "number" && value > 0 && value <= 8192;
    if ((body.width !== undefined && !size(body.width)) || (body.height !== undefined && !size(body.height))) {
      return c.json({ error: "width and height must be 1–8192" }, 400);
    }
    if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim() === "")) {
      return c.json({ error: "name must be a non-empty string" }, 400);
    }
    return agentWrite(c, (design) => ({
      ...design,
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(typeof body.width === "number" ? { width: body.width } : {}),
      ...(typeof body.height === "number" ? { height: body.height } : {}),
    }), (stored) => withoutThumbnails(stored));
  });

  app.post(`${AGENT_BASE}/designs/:id/move`, async (c) => {
    const ws = c.get("ws");
    const empty: { folderId?: string | null } = {};
    const body = await c.req.json<{ folderId?: string | null }>().catch(() => empty);
    const folderId = body.folderId === null || body.folderId === undefined ? undefined : await existingFolderId(ws, body.folderId);
    if (body.folderId && !folderId) {
      return c.json({ error: "Folder not found" }, 404);
    }
    return agentWrite(c, (design) => ({ ...design, folderId }), (stored) => {
      const { thumbnail: _thumbnail, ...summary } = toSummary(stored);
      return summary;
    });
  });

  /** A batch of page and layer edits, applied atomically (see ops.ts). */
  app.post(`${AGENT_BASE}/designs/:id/ops`, async (c) => {
    const ws = c.get("ws");
    const body = await c.req.json<{ ops?: unknown; baseRevision?: unknown }>().catch(() => null);
    if (!body) {
      return c.json({ error: "Body must be JSON: { ops: [...] }" }, 400);
    }
    const sizes = new Map<string, { width: number; height: number }>();
    // Photos already in frames too: changing a frame's box re-fits its photo.
    const current = await readDesign(ws, c.req.param("id"));
    const framed = (current?.pages ?? []).flatMap((page) => page.layers.flatMap((layer) => (layer.type === "frame" && layer.content ? [layer.content.asset] : [])));
    for (const asset of new Set([...assetsIn(body.ops), ...framed])) {
      if (!helpers.isSafeAssetFile(asset)) {
        continue;
      }
      const bytes = await readFile(path.join(ws.assetsDir, asset)).catch(() => null);
      const size = bytes ? imageSize(bytes) : null;
      if (size) {
        sizes.set(asset, size);
      }
    }
    let created: string[] = [];
    return agentWrite(c, (design) => {
      try {
        const result = applyOps(design, body.ops, { assetSize: (asset) => sizes.get(asset) ?? null, newId });
        created = result.created;
        return result.design;
      } catch (error) {
        if (error instanceof OpError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    }, (stored) => ({ revision: stored.revision ?? 0, created }), body.baseRevision);
  });

  app.get(`${AGENT_BASE}/designs/:id/lock`, async (c) => c.json(await getLock(c.get("ws"), c.req.param("id"))));

  app.post(`${AGENT_BASE}/designs/:id/lock`, async (c) => {
    const id = c.req.param("id");
    if (!await readDesign(c.get("ws"), id)) {
      return c.json({ error: "Not found" }, 404);
    }
    return (await lockForAgent(c, id)) ?? c.json(await getLock(c.get("ws"), id));
  });

  /** Claude's end of task: release its own lock. */
  app.delete(`${AGENT_BASE}/designs/:id/lock`, async (c) => {
    const released = await releaseLock(c.get("ws"), c.req.param("id"), "agent");
    return c.json({ ok: true, released });
  });

  /** Releases Luis's lock. Only when Luis asked for it (see the spec). */
  app.post(`${AGENT_BASE}/designs/:id/lock/release-human`, async (c) => {
    const released = await releaseLock(c.get("ws"), c.req.param("id"), "human");
    return c.json({ ok: true, released });
  });

  app.get(`${AGENT_BASE}/events`, (c) => eventStream(c, c.get("ws")));

  app.get(`${AGENT_BASE}/folders`, async (c) => c.json(await readFolders(c.get("ws"))));

  app.get(`${AGENT_BASE}/assets`, async (c) => {
    const folderId = c.req.query("folderId");
    const response = await helpers.listAssets(c);
    if (folderId === undefined || !response.ok) {
      return response;
    }
    const all = (await response.json()) as { folderId?: string }[];
    return c.json(all.filter((asset) => asset.folderId === folderId));
  });

  /** Uploads an image into Uploads (optionally a folder); returns its size. */
  app.post(`${AGENT_BASE}/assets`, async (c) => {
    const ws = c.get("ws");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Send multipart form data with a file field" }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: "File too large (25 MB max)" }, 400);
    }
    const ext = path.extname(file.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return c.json({ error: `Unsupported file type: ${ext || "(none)"} (images only for now: png, jpg, webp, gif, svg)` }, 400);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const size = imageSize(bytes);
    if (!size) {
      return c.json({ error: "Could not read the image (broken or not really that format)" }, 400);
    }
    const nameField = form?.get("name");
    const name = typeof nameField === "string" && nameField.trim() !== "" ? nameField.trim().slice(0, 200) : file.name;
    const asset = await saveAsset(ws, bytes, ext, name);
    const folderId = form?.get("folderId");
    let placedIn: string | undefined;
    if (typeof folderId === "string" && isSafeId(folderId) && await placeAssets(ws, [asset], folderId)) {
      placedIn = folderId;
    }
    publish(ws, { type: "assets.changed" });
    return c.json({ asset, name, width: size.width, height: size.height, folderId: placedIn }, 201);
  });

  registerAssetFolderRoutes(app, helpers.isSafeAssetFile, AGENT_BASE);
  registerRenderRoutes(app);
  registerFontRoutes(app, `${AGENT_BASE}/fonts`);
}
