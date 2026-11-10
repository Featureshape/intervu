import type { Plugin } from "vite";

/**
 * Dev-server setup both fixture configs share: `./vite.config.ts` on the
 * current Vite major and `../app-previous-vite/vite.config.ts` on the one
 * before it. Only types come from `vite` here, so the module works under either.
 */

/** The deps Vite pre-bundles up front, so the first page load does not reload. */
export const prebundledDeps = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-dev-runtime",
];

/** The response header that names the Vite version serving the fixture app. */
export const viteVersionHeaderName = "x-fixture-vite-version";

/**
 * Tags every dev-server response with `version`, the version of the Vite that
 * loaded the config, so a spec can prove which major served the page. Each
 * config passes its own `vite` export: importing it here would resolve the Vite
 * next to this file, not the one running.
 */
export const viteVersionHeader = (version: string): Plugin => ({
  name: "fixture-vite-version",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader(viteVersionHeaderName, version);
      next();
    });
  },
});
