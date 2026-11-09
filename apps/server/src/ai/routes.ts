import { randomUUID } from "node:crypto";
import { type AiImageJob, type AiSettingsInput, AI_IMAGE_NAME_PREFIX } from "@mycanvas/shared";
import { type Hono } from "hono";
import { saveAsset } from "../assets-store";
import { type Identity, knownAccounts } from "../auth";
import { SecretsUnavailableError } from "../secrets";
import { type Workspace } from "../storage";
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
    void generateImage(resolved.connection, resolved.apiKey, resolved.model, { prompt, width, height })
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
