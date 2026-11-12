import react from "@vitejs/plugin-react";
import { defineConfig, version } from "vite";
import { intervu } from "../../../src/vite/plugin.ts";
import { prebundledDeps, viteVersionHeader } from "./devServer.ts";

/**
 * The fixture app with owner-configured full-page redaction
 * (`intervu({ redact: true })`): every snapshot and annotation text leaves
 * the page masked. The redaction e2e spec runs against this instance.
 */
export default defineConfig({
  plugins: [react(), intervu({ redact: true }), viteVersionHeader(version)],
  cacheDir: `node_modules/.vite-${process.env.FIXTURE_APP_PORT ?? "default"}`,
  optimizeDeps: { include: prebundledDeps },
});
