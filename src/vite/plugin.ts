import type { Plugin } from "vite";
import { daemonPortFrom } from "../DaemonPort.ts";
import { jsxSourcePlugin } from "./jsxSource.ts";
import { loadOverlayJs } from "./overlayAsset.ts";
import {
  answerSessionLookup,
  guardInputOf,
  guardRequest,
  isRelayedRoute,
  ownOriginOf,
  ownSessionRouteKey,
  relayToDaemon,
  relayToOwnSession,
  sendError,
} from "./relay.ts";
import { overlayPath, relayPrefix, sessionPath } from "./relayPaths.ts";

/**
 * `intervu/vite`: the Vite plugin that puts intervu into a running app for URL
 * mode. On the dev server only (`apply: "serve"`, so a production build never
 * sees it) it
 *
 * - injects the in-page overlay script into every HTML page,
 * - mounts the same-origin relay under `/__intervu/`, which serves that script,
 *   answers its Session lookup and forwards the page's traffic to the loopback
 *   daemon, and
 * - stamps each element the app's own JSX renders with its source location
 *   (`./jsxSource.ts`).
 *
 * It is published as dependency-free ESM because Vite runs it on Node, while the
 * `intervu` binary needs Bun (ADR 0018).
 */

/** The Vite plugins that wire intervu's URL mode into the dev server. */
export const intervu = (): Plugin[] => [overlayPlugin(), jsxSourcePlugin()];

/** The overlay script and the relay it talks through. */
const overlayPlugin = (): Plugin => ({
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
      const guardInput = guardInputOf(request, { https, allowedHosts });
      const rejection = guardRequest(guardInput);
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

      if (method === "GET" && path === sessionPath) {
        answerSessionLookup(response, port, ownOriginOf(guardInput));
        return;
      }

      const key = ownSessionRouteKey(method, path);
      if (key !== null) {
        relayToOwnSession(
          request,
          response,
          port,
          ownOriginOf(guardInput),
          key,
          path,
        );
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
