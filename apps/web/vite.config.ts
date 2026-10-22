import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// MYCANVAS_API_PORT lets a second dev instance run next to the default one.
const api = `http://localhost:${process.env.MYCANVAS_API_PORT ?? "3001"}`;

export default defineConfig({
  plugins: [react()],
  // Uploaded images are served at /assets/*, so built files live elsewhere.
  build: { assetsDir: "static" },
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/assets": api,
    },
  },
});
