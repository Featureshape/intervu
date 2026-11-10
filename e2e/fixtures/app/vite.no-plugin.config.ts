import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { prebundledDeps } from "./devServer.ts";

/**
 * The fixture app served without the `intervu/vite` plugin, as an app the
 * agent points `intervu <url>` at before anyone has installed it. Everything
 * else matches `./vite.config.ts`, so only the plugin is missing.
 */
export default defineConfig({
  plugins: [react()],
  cacheDir: "node_modules/.vite-no-plugin",
  optimizeDeps: { include: prebundledDeps },
});
