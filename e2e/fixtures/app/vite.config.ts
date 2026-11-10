import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { intervu } from "../../../src/vite/plugin.ts";

/**
 * The fixture Vite + React app URL mode is proven against. It loads the
 * `intervu/vite` plugin from source; Playwright serves it once per daemon port
 * (`INTERVU_PORT`), so each instance gets its own dependency cache.
 */
export default defineConfig({
  plugins: [react(), intervu()],
  cacheDir: `node_modules/.vite-${process.env.INTERVU_PORT ?? "default"}`,
  optimizeDeps: {
    include: ["react", "react-dom/client", "react/jsx-dev-runtime"],
  },
});
