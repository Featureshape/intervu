import react from "@vitejs/plugin-react";
import { defineConfig, version } from "vite";
import { intervu } from "../../../src/vite/plugin.ts";
import { prebundledDeps, viteVersionHeader } from "./devServer.ts";

/**
 * The fixture Vite + React app URL mode is proven against, on the current Vite
 * major. It loads the `intervu/vite` plugin from source; Playwright serves it
 * several times, and each instance keys its dependency cache by its own port
 * (`FIXTURE_APP_PORT`). `../app-previous-vite` serves the same app on the previous
 * Vite major.
 */
export default defineConfig({
  plugins: [react(), intervu(), viteVersionHeader(version)],
  cacheDir: `node_modules/.vite-${process.env.FIXTURE_APP_PORT ?? "default"}`,
  optimizeDeps: { include: prebundledDeps },
});
