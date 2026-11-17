import { type Hono } from "hono";
import { AGENT_BASE } from "./agent/routes";
import { type AppEnv } from "./app";
import { SettingsError, maskedSettings, notifyConfig, parseSettingsChange, saveSettings, sendAll } from "./notify";
import { SecretsUnavailableError } from "./secrets";

/*
 * Each person's notification settings (notify.ts), for the editor and the
 * agent API alike, always in the caller's own workspace:
 *   GET  …/settings/notifications       masked settings
 *   PUT  …/settings/notifications       { telegram?: { botToken?, chatId? }, webhook?: { url?, topic?, token? } }
 *                                       (omitted keeps, "" or null clears)
 *   POST …/settings/notifications/test  sends a test message on every channel
 */

export function registerNotifyRoutes(app: Hono<AppEnv>): void {
  for (const base of ["/api/settings/notifications", `${AGENT_BASE}/settings/notifications`]) {
    app.get(base, async (c) => c.json(await maskedSettings(c.get("ws")), 200, { "Cache-Control": "no-store" }));

    app.put(base, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Send the settings as JSON" }, 400);
      }
      if (body === null || typeof body !== "object") {
        return c.json({ error: "Send the settings as a JSON object" }, 400);
      }
      try {
        return c.json(await saveSettings(c.get("ws"), parseSettingsChange(body as Record<string, unknown>)));
      } catch (error) {
        if (error instanceof SettingsError) {
          return c.json({ error: error.message }, 400);
        }
        if (error instanceof SecretsUnavailableError) {
          return c.json({ error: error.message }, 503);
        }
        throw error;
      }
    });

    app.post(`${base}/test`, async (c) => {
      const config = await notifyConfig(c.get("ws"));
      if (!config.telegram && !config.webhook) {
        return c.json({ error: "No channel is set up yet. Add a Telegram bot token and chat ID, or a webhook URL, and save.", results: [] }, 400);
      }
      const results = await sendAll(config, { kind: "test", designId: "", designName: "", reviewer: "", revision: 0 });
      return c.json({ ok: results.every((r) => r.ok), results }, 200);
    });
  }
}
