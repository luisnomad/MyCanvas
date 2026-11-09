import { serve } from "@hono/node-server";

import { app } from "./app";
import { LOCAL_USER } from "./auth";
import { migrateLegacyData } from "./storage";

const PORT = Number(process.env.PORT ?? 3001);

// Production must name the owner: pre-workspace data moves into the owner's
// workspace, and moving it into a placeholder one would hide it.
if (process.env.NODE_ENV === "production" && !process.env.MYCANVAS_LOCAL_USER?.trim()) {
  console.error("MYCANVAS_LOCAL_USER is not set; refusing to start.");
  process.exit(1);
}

await migrateLegacyData(LOCAL_USER);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`mycanvas server listening on http://localhost:${info.port} (owner: ${LOCAL_USER})`);
});
