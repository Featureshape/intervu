import react from "@vitejs/plugin-react";
import { defineConfig, version } from "vite";
import { intervu } from "../../../src/vite/plugin.ts";
import { prebundledDeps, viteVersionHeader } from "./devServer.ts";

/**
 * The fixture Vite + React app URL mode is proven against, on the current Vite
 * major. It loads the `intervu/vite` plugin from source; Playwright serves it
 * once per daemon port (`INTERVU_PORT`), so each instance gets its own
 * dependency cache. `../app-previous-vite` serves the same app on the previous
 * Vite major.
 */
export default defineConfig({
  plugins: [react(), intervu(), viteVersionHeader(version)],
  cacheDir: `node_modules/.vite-${process.env.INTERVU_PORT ?? "default"}`,
  optimizeDeps: { include: prebundledDeps },
});
