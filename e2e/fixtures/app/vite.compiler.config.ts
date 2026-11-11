import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, version } from "vite";
import { intervu } from "../../../src/vite/plugin.ts";
import { prebundledDeps, viteVersionHeader } from "./devServer.ts";

/**
 * The fixture app with the React Compiler on, the way `@vitejs/plugin-react`
 * documents it: a Babel pass that rewrites each component, adding lines of
 * memo-cache code, before React's JSX transform runs. Everything else matches
 * `./vite.config.ts`, so a spec can prove `source` still names the line the
 * app's author wrote.
 */
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    intervu(),
    viteVersionHeader(version),
  ],
  cacheDir: `node_modules/.vite-compiler-${process.env.FIXTURE_APP_PORT ?? "default"}`,
  optimizeDeps: { include: prebundledDeps },
});
