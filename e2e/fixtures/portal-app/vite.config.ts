import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { intervu } from "../../../src/vite/plugin.ts";

/**
 * A fixture app whose third-party component portals its content out of the
 * app's DOM subtree, served with the `intervu/vite` plugin loaded from source.
 */
export default defineConfig({
  plugins: [react(), intervu()],
  cacheDir: "node_modules/.vite-portal-app",
});
