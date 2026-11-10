import * as http from "node:http";
import { isIP } from "node:net";

/**
 * The relay half of the `intervu/vite` plugin: the dev server mounts it under
 * `/__intervu/` so the in-page overlay talks to the loopback daemon through its
 * own origin. The daemon stays loopback-only and sends no CORS headers; this
 * module is the only gate between the page and it, so it rejects any request
 * that a page on another origin could have sent.
 */

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

/** The dev server's own origin, as a page that reached it via `Host` sees it. */
export const ownOriginOf = (
  input: Pick<GuardInput, "host" | "https">,
): string => `${input.https ? "https" : "http"}://${input.host}`;

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
    if (input.origin !== ownOriginOf(input)) {
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

/** How long the relay waits for the daemon to answer a Session lookup. */
const lookupTimeoutMs = 1_000;

/** The relay's answer when no daemon is there to ask: no Session is open. */
const noSession = JSON.stringify({ session: null });

/**
 * Answer the overlay's "is a Session open for this origin?" by asking the
 * daemon's `GET /apps/session` for `origin`, the dev server's own origin as the
 * page reached it. The overlay asks every second while it rests as the dormant
 * badge, so a daemon that is not running, or not answering in time, is the
 * ordinary "no Session" answer rather than a `502`: a failed request would print
 * an error in the app's console that the page cannot suppress.
 */
export const answerSessionLookup = (
  response: http.ServerResponse,
  port: number,
  origin: string,
): void => {
  const answer = (body: string): void => {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(body);
    }
  };
  const upstream = http.get(
    {
      host: "127.0.0.1",
      port,
      path: `/apps/session?${new URLSearchParams({ origin })}`,
      timeout: lookupTimeoutMs,
    },
    (daemonResponse) => {
      if (daemonResponse.statusCode !== 200) {
        daemonResponse.resume();
        answer(noSession);
        return;
      }
      const chunks: Buffer[] = [];
      daemonResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
      daemonResponse.on("end", () =>
        answer(Buffer.concat(chunks).toString("utf8")),
      );
      daemonResponse.on("error", () => answer(noSession));
    },
  );
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", () => answer(noSession));
  response.on("close", () => upstream.destroy());
};
