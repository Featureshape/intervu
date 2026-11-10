import nodePath from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, version } from "vite";
import { intervu } from "../../../src/vite/plugin.ts";
import { prebundledDeps, viteVersionHeader } from "../app/devServer.ts";

/**
 * The fixture app served by the previous Vite major. This workspace pins that
 * Vite and the `@vitejs/plugin-react` that supports it, and serves the same app
 * (`../app`) with the `intervu/vite` plugin loaded from source. Bump the `vite`
 * pin in `./package.json` with the root's Vite major: the dormant-badge spec
 * fails while this workspace is not exactly one major behind.
 */
export default defineConfig({
  root: nodePath.join(import.meta.dirname, "..", "app"),
  plugins: [react(), intervu(), viteVersionHeader(version)],
  cacheDir: nodePath.join(
    import.meta.dirname,
    "node_modules",
    `.vite-${process.env.INTERVU_PORT ?? "default"}`,
  ),
  optimizeDeps: { include: prebundledDeps },
});
