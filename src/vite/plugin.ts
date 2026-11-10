import type { Plugin } from "vite";
import { daemonPortFrom } from "../DaemonPort.ts";
import { loadOverlayJs } from "./overlayAsset.ts";
import {
  guardInputOf,
  guardRequest,
  isRelayedRoute,
  relayPrefix,
  relayToDaemon,
  sendError,
} from "./relay.ts";

/**
 * `intervu/vite`: the Vite plugin that puts intervu into a running app for URL
 * mode. On the dev server only (`apply: "serve"`, so a production build never
 * sees it) it
 *
 * - injects the in-page overlay script into every HTML page, and
 * - mounts the same-origin relay under `/__intervu/`, which serves that script
 *   and forwards the page's traffic to the loopback daemon.
 *
 * It is published as dependency-free ESM because Vite runs it on Node, while the
 * `intervu` binary needs Bun (ADR 0018).
 */

/** The relay path that serves the overlay script. */
const overlayPath = "/overlay.js";

/** The Vite plugin that wires intervu's URL mode into the dev server. */
export const intervu = (): Plugin => ({
  name: "intervu",
  apply: "serve",
  configureServer(server) {
    // Found the way the CLI finds it, so both reach the same daemon.
    const port = daemonPortFrom(process.env.INTERVU_PORT);
    const https = server.config.server.https !== undefined;
    const allowedHosts = server.config.server.allowedHosts;
    // Built once per dev server start; every page load awaits the same build.
    const overlay = loadOverlayJs();

    server.middlewares.use(relayPrefix, (request, response) => {
      const rejection = guardRequest(
        guardInputOf(request, { https, allowedHosts }),
      );
      if (rejection !== null) {
        sendError(
          response,
          403,
          "ForeignOrigin",
          `intervu only answers the dev server's own origin (${rejection})`,
        );
        return;
      }

      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      if (method === "GET" && path === overlayPath) {
        overlay.then((build) => {
          if (build.ok) {
            response.writeHead(200, {
              "content-type": "text/javascript",
              "cache-control": "no-store",
            });
            response.end(build.code);
          } else {
            server.config.logger.error(`[intervu] ${build.reason}`);
            sendError(response, 500, "OverlayBuildFailed", build.reason);
          }
        });
        return;
      }

      if (!isRelayedRoute(method, path)) {
        sendError(
          response,
          404,
          "RouteNotRelayed",
          `${method} ${relayPrefix}${path} is not an intervu relay route`,
        );
        return;
      }
      relayToDaemon(request, response, port, path);
    });
  },
  transformIndexHtml() {
    return [
      {
        tag: "script",
        attrs: { type: "module", src: `${relayPrefix}${overlayPath}` },
        injectTo: "body",
      },
    ];
  },
});

export default intervu;
