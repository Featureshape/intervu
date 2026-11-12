import type { Plugin } from "vite";
import { daemonPortFrom } from "../DaemonPort.ts";
import { jsxSourcePlugin } from "./jsxSource.ts";
import { loadOverlayJs } from "./overlayAsset.ts";
import {
  answerSessionLookup,
  describeRejection,
  guardInputOf,
  guardRequest,
  isRelayedRoute,
  ownSessionRouteKey,
  relayTargetOf,
  relayToDaemon,
  relayToOwnSession,
  sendError,
  sendGuardRefusal,
} from "./relay.ts";
import {
  overlayPath,
  ownMarkupAttribute,
  relayPrefix,
  sessionPath,
} from "./relayPaths.ts";

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
    const warnOnce = onceLogger((message) =>
      server.config.logger.warn(message, { timestamp: true }),
    );

    server.middlewares.use(relayPrefix, (request, response) => {
      const method = request.method ?? "GET";
      const { path, pageOrigin } = relayTargetOf(request.url ?? "/");
      const guardInput = guardInputOf(request, pageOrigin, {
        https,
        allowedHosts,
      });
      const verdict = guardRequest(guardInput);
      if (!verdict.pass) {
        warnOnce(
          describeRejection(method, path, verdict.rejection, guardInput),
        );
        sendGuardRefusal(response, verdict.rejection, guardInput);
        return;
      }

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
        answerSessionLookup(response, port, verdict.pageOrigin);
        return;
      }

      const key = ownSessionRouteKey(method, path);
      if (key !== null) {
        relayToOwnSession(
          request,
          response,
          port,
          verdict.pageOrigin,
          key,
          path,
          warnOnce,
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
        attrs: {
          type: "module",
          src: `${relayPrefix}${overlayPath}`,
          [ownMarkupAttribute]: "",
        },
        injectTo: "body",
      },
    ];
  },
});

/** How many distinct warnings one dev server prints before it stops. */
const warningLimit = 50;

/**
 * Wrap `log` so each distinct message prints once: the dormant badge asks the
 * relay every second, and a refusal should be one line in the terminal, not a
 * line a second. Past `warningLimit` distinct messages it goes quiet, so a
 * client spraying varied requests cannot flood the log.
 */
const onceLogger = (log: (message: string) => void) => {
  const seen = new Set<string>();
  return (message: string): void => {
    if (seen.has(message) || seen.size >= warningLimit) {
      return;
    }
    seen.add(message);
    log(message);
  };
};

export default intervu;
