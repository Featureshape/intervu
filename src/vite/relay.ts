import * as http from "node:http";
import { isIP } from "node:net";

/**
 * The relay half of the `intervu/vite` plugin: the dev server mounts it under
 * `/__intervu/` so the in-page overlay talks to the loopback daemon through its
 * own origin. The daemon stays loopback-only and sends no CORS headers; this
 * module is the only gate between the page and it, so it rejects any request
 * that a page on another origin could have sent.
 */

/** The URL prefix the plugin mounts the relay under on the dev server. */
export const relayPrefix = "/__intervu";

/** The daemon routes the page may reach through the relay, by method. */
const relayedRoutes: readonly {
  readonly method: string;
  readonly path: RegExp;
}[] = [{ method: "GET", path: /^\/health$/ }];

/** The request headers forwarded to the daemon; everything else is dropped. */
const forwardedRequestHeaders = [
  "accept",
  "content-type",
  "content-length",
  "last-event-id",
] as const;

/** Hop-by-hop response headers the relay must not copy to the page. */
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

/** What the guard knows about a request and the dev server it reached. */
export interface GuardInput {
  /** The `Host` header, the address the browser used to reach the server. */
  readonly host: string | undefined;
  /** The `Origin` header, absent on same-origin GETs and non-browser clients. */
  readonly origin: string | undefined;
  /** The `Sec-Fetch-Site` header browsers attach to every request. */
  readonly secFetchSite: string | undefined;
  /** Whether the dev server serves https. */
  readonly https: boolean;
  /** Vite's `server.allowedHosts`: extra hostnames the server answers to. */
  readonly allowedHosts: readonly string[] | true;
}

/** Why the guard turned a request away, or `null` when it may pass. */
export type GuardRejection =
  | "foreign-host"
  | "foreign-origin"
  | "cross-site-fetch";

/** The hostname part of a `Host` header, without port or IPv6 brackets. */
const hostnameOf = (host: string): string | null => {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
};

/**
 * Whether `hostname` is one the dev server answers to without DNS rebinding
 * risk: loopback names, IP literals, or a host the user allowed in Vite.
 */
const isTrustedHostname = (
  hostname: string,
  allowedHosts: readonly string[] | true,
): boolean => {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIP(hostname) !== 0
  ) {
    return true;
  }
  if (allowedHosts === true) {
    return true;
  }
  return allowedHosts.some((allowed) =>
    allowed.startsWith(".")
      ? hostname === allowed.slice(1) || hostname.endsWith(allowed)
      : hostname === allowed,
  );
};

/**
 * Decide whether a request to the relay came from the dev server's own origin.
 *
 * Browsers mark cross-site requests with `Sec-Fetch-Site` and attach `Origin` to
 * every CORS-mode or non-GET request, so either header naming another origin is
 * a rejection. Requests carrying neither (the CLI, a same-origin GET) pass. The
 * `Host` check closes DNS rebinding, where a foreign name resolves to loopback
 * and `Origin` would otherwise match the forged `Host`.
 */
export const guardRequest = (input: GuardInput): GuardRejection | null => {
  const hostname = input.host === undefined ? null : hostnameOf(input.host);
  if (hostname === null || !isTrustedHostname(hostname, input.allowedHosts)) {
    return "foreign-host";
  }
  if (
    input.secFetchSite !== undefined &&
    input.secFetchSite !== "same-origin" &&
    input.secFetchSite !== "none"
  ) {
    return "cross-site-fetch";
  }
  if (input.origin !== undefined) {
    const ownOrigin = `${input.https ? "https" : "http"}://${input.host}`;
    if (input.origin !== ownOrigin) {
      return "foreign-origin";
    }
  }
  return null;
};

/** Whether the page may reach `path` on the daemon with `method`. */
export const isRelayedRoute = (method: string, path: string): boolean =>
  relayedRoutes.some(
    (route) => route.method === method && route.path.test(path),
  );

/** A single-valued request header, or `undefined` when absent. */
const headerOf = (
  request: http.IncomingMessage,
  name: string,
): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** Read the guard's input off a live request. */
export const guardInputOf = (
  request: http.IncomingMessage,
  server: {
    readonly https: boolean;
    readonly allowedHosts: readonly string[] | true;
  },
): GuardInput => ({
  host: headerOf(request, "host"),
  origin: headerOf(request, "origin"),
  secFetchSite: headerOf(request, "sec-fetch-site"),
  https: server.https,
  allowedHosts: server.allowedHosts,
});

/** The tags of the errors the relay answers with. */
export type RelayErrorTag =
  | "ForeignOrigin"
  | "RouteNotRelayed"
  | "DaemonUnreachable"
  | "OverlayBuildFailed";

/** End `response` with a JSON body in the CLI's `{error:{tag,message}}` shape. */
export const sendError = (
  response: http.ServerResponse,
  status: number,
  tag: RelayErrorTag,
  message: string,
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { tag, message } }));
};

/**
 * Forward `request` to the daemon at `127.0.0.1:port` as `path`, streaming the
 * body both ways so a Server-Sent Events response reaches the page as it is
 * written. A daemon that does not answer becomes a 502 `DaemonUnreachable`.
 */
export const relayToDaemon = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  port: number,
  path: string,
): void => {
  const headers: Record<string, string | string[]> = {};
  for (const name of forwardedRequestHeaders) {
    const value = request.headers[name];
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port,
      method: request.method ?? "GET",
      path,
      headers,
    },
    (daemonResponse) => {
      const relayed: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(daemonResponse.headers)) {
        if (value !== undefined && !hopByHopHeaders.has(name)) {
          relayed[name] = value;
        }
      }
      response.writeHead(daemonResponse.statusCode ?? 502, relayed);
      response.flushHeaders();
      daemonResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent && !response.destroyed) {
      sendError(
        response,
        502,
        "DaemonUnreachable",
        `the intervu daemon is not answering on 127.0.0.1:${port}`,
      );
    } else {
      response.destroy();
    }
  });
  // A page that closes its stream (a tab closing an EventSource) ends the
  // daemon connection too, so the daemon sees the live connection go away.
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
};
