import { randomUUID } from "node:crypto";
import { type AiImageJob, type AiSettingsInput, AI_IMAGE_NAME_PREFIX, isAccountKind } from "@mycanvas/shared";
import { type Hono } from "hono";
import { saveAsset } from "../assets-store";
import { type Identity, knownAccounts } from "../auth";
import { SecretsUnavailableError } from "../secrets";
import { type Workspace } from "../storage";
import { accountCredits, accountImage, accountModels, finishOAuthLogin, loginStatus, startLogin } from "./accounts";
import { checkNetworkAccess, isOwner, readAdminSettings, saveAdminSettings } from "./network";
import { ProviderError, generateImage, generateText, listModels } from "./providers";
import { AiSettingsError, readAiSettings, resolveConnection, saveAiSettings } from "./settings";

interface AppEnv { Variables: { ws: Workspace; identity: Identity } }

/** Image jobs in memory: they take seconds to minutes, longer than a proxied request may wait. */
const jobs = new Map<string, AiImageJob & { workspace: string; finishedAt?: number }>();

function pruneJobs() {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && job.finishedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

/** Errors people can act on become 400 with the message; anything else is a 500. */
function failure(error: unknown): { message: string; status: 400 | 500 | 503 } {
  if (error instanceof SecretsUnavailableError) {
    return { message: error.message, status: 503 };
  }
  if (error instanceof AiSettingsError || error instanceof ProviderError) {
    return { message: error.message, status: 400 };
  }
  console.error("AI request failed", error);
  return { message: "Something went wrong talking to the AI provider.", status: 500 };
}

async function assignment(ws: Workspace, email: string, role: "text" | "image") {
  const settings = await readAiSettings(ws, email);
  const chosen = settings[role];
  if (!chosen) {
    throw new AiSettingsError(role === "text" ? "No text model is set up. Open AI settings to choose one." : "No image model is set up. Open AI settings to choose one.");
  }
  const { connection, apiKey } = await resolveConnection(ws, chosen.connectionId, email);
  await checkNetworkAccess(connection, email);
  return { connection, apiKey, model: chosen.model };
}

export function registerAiRoutes(app: Hono<AppEnv>): void {
  app.get("/api/ai/settings", async (c) => c.json(await readAiSettings(c.get("ws"), c.get("identity").email)));

  app.put("/api/ai/settings", async (c) => {
    try {
      return c.json(await saveAiSettings(c.get("ws"), await c.req.json<AiSettingsInput>(), c.get("identity").email));
    } catch (error) {
      const { message, status } = failure(error);
      return c.json({ error: message }, status);
    }
  });

  /** Lists a saved connection's models; doubles as a connection test. */
  app.post("/api/ai/models", async (c) => {
    try {
      const { connectionId } = await c.req.json<{ connectionId: string }>();
      const { connection, apiKey } = await resolveConnection(c.get("ws"), connectionId, c.get("identity").email);
      if (isAccountKind(connection.kind)) {
        return c.json({ models: await accountModels(c.get("ws"), connection, apiKey) });
      }
      await checkNetworkAccess(connection, c.get("identity").email);
      return c.json({ models: await listModels(connection, apiKey) });
    } catch (error) {
      const { message, status } = failure(error);
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/ai/text", async (c) => {
    try {
      const body = await c.req.json<{ system?: string; prompt?: string; json?: boolean; temperature?: number; images?: unknown }>();
      const images = Array.isArray(body.images) ? body.images : [];
      if (images.length > 4 || !images.every((url): url is string => typeof url === "string" && /^data:image\/(?:png|jpeg|webp);base64,/.test(url) && url.length < 8_000_000)) {
        return c.json({ error: "Up to 4 PNG/JPEG/WebP images, 6 MB each." }, 400);
      }
      if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 200_000) {
        return c.json({ error: "Missing or oversized prompt." }, 400);
      }
      const { connection, apiKey, model } = await assignment(c.get("ws"), c.get("identity").email, "text");
      const text = await generateText(connection, apiKey, model, {
        system: typeof body.system === "string" ? body.system.slice(0, 50_000) : "",
        prompt: body.prompt,
        json: body.json === true,
        temperature: typeof body.temperature === "number" ? Math.min(2, Math.max(0, body.temperature)) : undefined,
        images,
      });
      return c.json({ text, model, connection: connection.name });
    } catch (error) {
      const { message, status } = failure(error);
      return c.json({ error: message }, status);
    }
  });

  /** Starts an image job; poll /api/ai/jobs/:id. The result lands in the person's uploads. */
  app.post("/api/ai/image", async (c) => {
    const ws = c.get("ws");
    let resolved;
    let body: { prompt?: string; width?: number; height?: number; name?: string };
    try {
      body = await c.req.json<typeof body>();
      if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 8000) {
        return c.json({ error: "Missing or oversized prompt." }, 400);
      }
      resolved = await assignment(ws, c.get("identity").email, "image");
    } catch (error) {
      const { message, status } = failure(error);
      return c.json({ error: message }, status);
    }
    pruneJobs();
    const id = randomUUID();
    const job: AiImageJob & { workspace: string; finishedAt?: number } = { id, state: "running", workspace: ws.key };
    jobs.set(id, job);
    const width = Math.min(4096, Math.max(64, Math.round(Number(body.width) || 1024)));
    const height = Math.min(4096, Math.max(64, Math.round(Number(body.height) || 1024)));
    const prompt = body.prompt.trim();
    const label = (typeof body.name === "string" && body.name.trim() ? body.name.trim() : prompt).slice(0, 60);
    const { connection, apiKey, model } = resolved;
    const make = isAccountKind(connection.kind)
      ? accountImage(ws, connection, apiKey, model, { prompt, width, height })
      : generateImage(connection, apiKey, model, { prompt, width, height });
    void make
      .then(async (image) => {
        job.asset = await saveAsset(ws, image.bytes, image.extension, `${AI_IMAGE_NAME_PREFIX}${label}${image.extension}`);
        job.state = "done";
      })
      .catch((error: unknown) => {
        job.state = "error";
        job.error = failure(error).message;
      })
      .finally(() => {
        job.finishedAt = Date.now();
      });
    return c.json({ id, state: job.state } satisfies AiImageJob, 202);
  });

  app.get("/api/ai/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (job?.workspace !== c.get("ws").key) {
      return c.json({ error: "Not found" }, 404);
    }
    const { workspace: _workspace, finishedAt: _finishedAt, ...visible } = job;
    return c.json(visible);
  });

  /** Account connections (Kling, Runway, PixVerse): start a login; the browser opens the address. */
  app.post("/api/ai/login", async (c) => {
    try {
      const { connectionId } = await c.req.json<{ connectionId: string }>();
      const ws = c.get("ws");
      const email = c.get("identity").email;
      const { connection } = await resolveConnection(ws, connectionId, email);
      if (!isAccountKind(connection.kind)) {
        return c.json({ error: `${connection.name} uses a key, not a login.` }, 400);
      }
      // The page's own address, so the service sends the browser back to where it came from.
      const origin = c.req.header("origin") ?? new URL(c.req.url).origin;
      return c.json(await startLogin(ws, email, connection, origin));
    } catch (error) {
      const { message, status } = failure(error);
      return c.json({ error: message }, status);
    }
  });

  app.get("/api/ai/login/:id", (c) => {
    const status = loginStatus(c.req.param("id"), c.get("ws"));
    return status ? c.json(status) : c.json({ error: "Not found" }, 404);
  });

  /** Where Kling and Runway send the browser back after the person approves. */
  app.get("/api/ai/oauth/callback", async (c) => {
    let title = "Logged in";
    let message = "You can close this tab and go back to MyCanvas.";
    try {
      const login = await finishOAuthLogin(c.req.query("state") ?? "", c.req.query("code"), c.req.query("error"), c.get("identity").email);
      if (login.state === "error") {
        title = "Login failed";
        message = login.error ?? "The login failed.";
      } else {
        title = `Logged in to ${login.connection.name}`;
      }
    } catch (error) {
      title = "Login failed";
      message = failure(error).message;
    }
    const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${String(ch.charCodeAt(0))};`);
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>` +
      `<style>body{font:16px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f2;color:#222}main{max-width:28rem;padding:2rem}@media(prefers-color-scheme:dark){body{background:#1d1d1f;color:#eee}}</style>` +
      `</head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main><script>setTimeout(function(){window.close()},1500)</script></body></html>`);
  });

  /** Credits left on an account connection. */
  app.post("/api/ai/credits", async (c) => {
    try {
      const { connectionId } = await c.req.json<{ connectionId: string }>();
      const ws = c.get("ws");
      const { connection, apiKey } = await resolveConnection(ws, connectionId, c.get("identity").email);
      if (!isAccountKind(connection.kind)) {
        return c.json({ error: `${connection.name} doesn't report credits.` }, 400);
      }
      return c.json(await accountCredits(ws, connection, apiKey));
    } catch (error) {
      const { message, status } = failure(error);
      return c.json({ error: message }, status);
    }
  });

  /** Owner only: which accounts may use the server's local network for AI. */
  app.get("/api/admin/ai", async (c) => {
    if (!isOwner(c.get("identity").email)) {
      return c.json({ error: "Only the owner can change this." }, 403);
    }
    const settings = await readAdminSettings();
    const accounts = knownAccounts().filter((email) => !isOwner(email));
    return c.json({ ...settings, accounts: [...new Set([...accounts, ...settings.aiLocalNetwork])] });
  });

  app.put("/api/admin/ai", async (c) => {
    if (!isOwner(c.get("identity").email)) {
      return c.json({ error: "Only the owner can change this." }, 403);
    }
    const body = await c.req.json<{ aiLocalNetwork?: unknown }>();
    const list = Array.isArray(body.aiLocalNetwork) ? body.aiLocalNetwork.filter((email): email is string => typeof email === "string") : [];
    return c.json(await saveAdminSettings({ aiLocalNetwork: list }));
  });

  /** Whether text and images are set up, for enabling AI buttons. */
  app.get("/api/ai/status", async (c) => {
    const settings = await readAiSettings(c.get("ws"), c.get("identity").email);
    return c.json({ text: settings.text !== null, image: settings.image !== null });
  });
}
