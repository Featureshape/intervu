import * as http from "node:http";
import { isIP } from "node:net";
import { appSessionUrl, sessionKeyPattern } from "../DaemonRoutes.ts";
import type { GuardRejection } from "./guardRefusal.ts";
import { relayPrefix } from "./relayPaths.ts";
import { openSessionKeyIn } from "./sessionAnswer.ts";

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
  /**
   * The host a reverse proxy in front of the dev server says the browser used
   * (`X-Forwarded-Host`, or `host=` in `Forwarded`), when one does.
   */
  readonly forwardedHost: string | undefined;
  /**
   * The scheme a reverse proxy says the browser used (`X-Forwarded-Proto`, or
   * `proto=` in `Forwarded`), when one does.
   */
  readonly forwardedProto: string | undefined;
  /**
   * The page's own `location.origin`, which the overlay names in the `origin`
   * query parameter of every relay request. It is the browser's side of the
   * connection, so it stays right behind a TLS-terminating proxy, where the
   * dev server only sees plain http.
   */
  readonly pageOrigin: string | undefined;
  /** Whether the dev server serves https. */
  readonly https: boolean;
  /** Vite's `server.allowedHosts`: extra hostnames the server answers to. */
  readonly allowedHosts: readonly string[] | true;
}

/**
 * The guard's verdict: a request that may pass, with the origin of the page
 * that sent it, or the reason it was turned away.
 */
export type GuardVerdict =
  | { readonly pass: true; readonly pageOrigin: string }
  | { readonly pass: false; readonly rejection: GuardRejection };

/** The hostname part of a `Host` header, without port or IPv6 brackets. */
const hostnameOf = (host: string): string | null =>
  URL.parse(`http://${host}`)?.hostname.replace(/^\[|\]$/g, "") ?? null;

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

/** The port `url` names, or its scheme's default when it names none. */
const effectivePortOf = (url: URL): string =>
  url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";

/**
 * `origin` as an `http:` or `https:` URL, or `null` when it is not one (an
 * opaque `null` origin, a `file:` page, garbage).
 */
const webOriginOf = (origin: string): URL | null => {
  const parsed = URL.parse(origin);
  return parsed !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:")
    ? parsed
    : null;
};

/**
 * Whether `origin` is the address the browser used to reach this dev server:
 * its hostname is one the server trusts, and its host and port are the `Host`
 * the request arrived with, or the host a proxy in front forwarded. The scheme
 * is left out on purpose: a TLS-terminating proxy turns the browser's https
 * into plain http, and `Sec-Fetch-Site` already rejects a page on another
 * scheme. A `Host` without a port takes the default of `origin`'s scheme, so
 * `https://app.test` matches the `Host: app.test` a proxy sends.
 */
const isServerOrigin = (origin: URL, input: GuardInput): boolean => {
  if (
    !isTrustedHostname(
      origin.hostname.replace(/^\[|\]$/g, ""),
      input.allowedHosts,
    )
  ) {
    return false;
  }
  return [input.host, input.forwardedHost].some((host) => {
    if (host === undefined) {
      return false;
    }
    const reached = URL.parse(`${origin.protocol}//${host}`);
    return (
      reached !== null &&
      reached.hostname === origin.hostname &&
      effectivePortOf(reached) === effectivePortOf(origin)
    );
  });
};

/**
 * The page origin the dev server works out on its own, for a request that
 * names none (the CLI, a same-origin GET): the scheme and host a proxy
 * forwarded, else the server's own scheme and the `Host` header. Normalised the
 * way `URL` does it, so `HTTP://App.Test:80` and `http://app.test` are one.
 */
const derivedOriginOf = (input: GuardInput, host: string): string => {
  const scheme =
    input.forwardedProto === "https" || input.forwardedProto === "http"
      ? input.forwardedProto
      : input.https
        ? "https"
        : "http";
  const authority = input.forwardedHost ?? host;
  return (
    URL.parse(`${scheme}://${authority}`)?.origin ?? `${scheme}://${authority}`
  );
};

/**
 * Decide whether a request to the relay came from the dev server's own page,
 * and if so, which origin that page is on.
 *
 * The `Host` check closes DNS rebinding, where a foreign name resolves to
 * loopback. Browsers mark a request from another site with `Sec-Fetch-Site`,
 * which is what keeps every other page out. An `Origin` header, and the page
 * origin the overlay names, must each be an address this dev server answers
 * to (`isServerOrigin`), and must agree when both are there. A request naming
 * neither (the CLI, a same-origin GET from an older overlay) gets the origin
 * the server derives from `Host` and any proxy headers.
 */
export const guardRequest = (input: GuardInput): GuardVerdict => {
  const hostname = input.host === undefined ? null : hostnameOf(input.host);
  if (
    input.host === undefined ||
    hostname === null ||
    !isTrustedHostname(hostname, input.allowedHosts)
  ) {
    return { pass: false, rejection: "foreign-host" };
  }
  if (
    input.secFetchSite !== undefined &&
    input.secFetchSite !== "same-origin" &&
    input.secFetchSite !== "none"
  ) {
    return { pass: false, rejection: "cross-site-fetch" };
  }
  const origin =
    input.origin === undefined ? undefined : webOriginOf(input.origin);
  if (
    origin === null ||
    (origin !== undefined && !isServerOrigin(origin, input))
  ) {
    return { pass: false, rejection: "foreign-origin" };
  }
  const page =
    input.pageOrigin === undefined ? undefined : webOriginOf(input.pageOrigin);
  if (
    page === null ||
    (page !== undefined &&
      (!isServerOrigin(page, input) ||
        (origin !== undefined && origin.origin !== page.origin)))
  ) {
    return { pass: false, rejection: "foreign-page-origin" };
  }
  return {
    pass: true,
    pageOrigin:
      page?.origin ?? origin?.origin ?? derivedOriginOf(input, input.host),
  };
};

/** What each rejection means, for the dev server's log. */
const rejectionReasons: Record<GuardRejection, string> = {
  "foreign-host":
    "its Host is not a name this dev server trusts - add the hostname to server.allowedHosts in vite.config.ts",
  "cross-site-fetch":
    "the browser marked it as sent from another site (Sec-Fetch-Site)",
  "foreign-origin":
    "its Origin is not an address this dev server answers to - behind a proxy, forward the browser's Host (or X-Forwarded-Host) and add the hostname to server.allowedHosts",
  "foreign-page-origin":
    "the page origin the overlay named is not an address this dev server answers to - behind a proxy, forward the browser's Host (or X-Forwarded-Host) and add the hostname to server.allowedHosts",
};

/**
 * One log line that says why the guard refused a request and what it saw, so
 * a refusal behind a proxy explains itself in the dev server's terminal.
 */
export const describeRejection = (
  method: string,
  path: string,
  rejection: GuardRejection,
  input: GuardInput,
): string => {
  const seen = [
    ["Host", input.host],
    ["Origin", input.origin],
    ["page origin", input.pageOrigin],
    ["Sec-Fetch-Site", input.secFetchSite],
    ["forwarded host", input.forwardedHost],
    ["forwarded proto", input.forwardedProto],
  ]
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${value}`)
    .join(", ");
  return `[intervu] refused ${method} ${relayPrefix}${path}: ${rejectionReasons[rejection]} (${seen === "" ? "no Host" : seen})`;
};

/**
 * The Session-scoped daemon routes the page may reach through the relay, by
 * method; the first capture group of `path` is the Session key. The relay
 * forwards one only for the `app` Session open for the page's own origin, so a
 * script in the app cannot reach another Session by guessing its key.
 */
const ownSessionRoutes: readonly {
  readonly method: string;
  readonly path: RegExp;
}[] = [
  { method: "POST", path: new RegExp(`^/s/(${sessionKeyPattern})/feedback$`) },
  { method: "GET", path: new RegExp(`^/s/(${sessionKeyPattern})/events$`) },
];

/** Whether the page may reach `path` on the daemon with `method`. */
export const isRelayedRoute = (method: string, path: string): boolean =>
  relayedRoutes.some(
    (route) => route.method === method && route.path.test(path),
  );

/**
 * The Session key a Session-scoped relay route names, or `null` when `method`
 * and `path` are not one.
 */
export const ownSessionRouteKey = (
  method: string,
  path: string,
): string | null => {
  for (const route of ownSessionRoutes) {
    const key = route.method === method ? route.path.exec(path)?.[1] : null;
    if (key !== undefined && key !== null) {
      return key;
    }
  }
  return null;
};

/** A single-valued request header, or `undefined` when absent. */
const headerOf = (
  request: http.IncomingMessage,
  name: string,
): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The first value of a comma-separated header such as `X-Forwarded-Host`. */
const firstValueOf = (value: string | undefined): string | undefined => {
  const first = value?.split(",")[0]?.trim();
  return first === undefined || first === "" ? undefined : first;
};

/**
 * The `name=` parameter of the first element of an RFC 7239 `Forwarded`
 * header, unquoted, or `undefined` when it has none.
 */
export const forwardedParamOf = (
  forwarded: string | undefined,
  name: "host" | "proto",
): string | undefined => {
  const first = forwarded?.split(",")[0];
  for (const pair of first?.split(";") ?? []) {
    const [key, ...rest] = pair.split("=");
    if (key?.trim().toLowerCase() === name) {
      const value = rest
        .join("=")
        .trim()
        .replace(/^"(.*)"$/, "$1");
      return value === "" ? undefined : value;
    }
  }
  return undefined;
};

/** A relay request's path, split from the page origin its query names. */
export interface RelayTarget {
  /** The relay path without its query, as the daemon routes see it. */
  readonly path: string;
  /** The `origin` query parameter, the page's own `location.origin`. */
  readonly pageOrigin: string | undefined;
}

/** Split a relay request's URL into its path and the page origin it names. */
export const relayTargetOf = (url: string): RelayTarget => {
  const parsed = URL.parse(url, "http://relay.invalid");
  return {
    path: parsed?.pathname ?? url,
    pageOrigin: parsed?.searchParams.get("origin") ?? undefined,
  };
};

/** Read the guard's input off a live request. */
export const guardInputOf = (
  request: http.IncomingMessage,
  pageOrigin: string | undefined,
  server: {
    readonly https: boolean;
    readonly allowedHosts: readonly string[] | true;
  },
): GuardInput => {
  const forwarded = headerOf(request, "forwarded");
  return {
    host: headerOf(request, "host"),
    origin: headerOf(request, "origin"),
    secFetchSite: headerOf(request, "sec-fetch-site"),
    forwardedHost:
      firstValueOf(headerOf(request, "x-forwarded-host")) ??
      forwardedParamOf(forwarded, "host"),
    forwardedProto:
      firstValueOf(headerOf(request, "x-forwarded-proto"))?.toLowerCase() ??
      forwardedParamOf(forwarded, "proto")?.toLowerCase(),
    pageOrigin,
    https: server.https,
    allowedHosts: server.allowedHosts,
  };
};

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
 * The 403 body of a request the guard refused: the rejection code as `reason`
 * and the origins the request itself presented, so the badge's card can name
 * both. It echoes only what the caller sent - the server's trusted-host list
 * stays in the dev server log (`describeRejection`), out of a foreign page's
 * reach.
 */
export const guardRefusalBodyOf = (
  rejection: GuardRejection,
  input: GuardInput,
): string =>
  JSON.stringify({
    error: {
      tag: "ForeignOrigin",
      message: `intervu only answers the dev server's own origin (${rejection})`,
      reason: rejection,
      origin: input.origin,
      pageOrigin: input.pageOrigin,
    },
  });

/** End `response` as a 403 carrying the guard's refusal. */
export const sendGuardRefusal = (
  response: http.ServerResponse,
  rejection: GuardRejection,
  input: GuardInput,
): void => {
  response.writeHead(403, { "content-type": "application/json" });
  response.end(guardRefusalBodyOf(rejection, input));
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

/**
 * The relay's answer when no daemon was there to ask: no Session is open, and
 * the badge's card can say which port(s) the relay tried. An overlay from
 * before the `daemon` field ignores it and keeps reading `session: null`.
 */
const noDaemonAnswer = (ports: readonly number[]): string =>
  JSON.stringify({ session: null, daemon: "unreachable", ports });

/**
 * Ask the daemon's `GET /apps/session` which Session is open for `origin`, the
 * dev server's own origin as the page reached it. Resolves the daemon's JSON
 * answer, or `null` when the daemon is not running, not answering in time, or
 * answering anything but a `200`. Aborting `signal` gives up on the daemon.
 */
const lookupSession = (
  port: number,
  origin: string,
  signal: AbortSignal,
): Promise<string | null> =>
  new Promise((resolve) => {
    const upstream = http.get(
      {
        host: "127.0.0.1",
        port,
        path: appSessionUrl(origin),
        timeout: lookupTimeoutMs,
        signal,
      },
      (daemonResponse) => {
        if (daemonResponse.statusCode !== 200) {
          daemonResponse.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        daemonResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
        daemonResponse.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
        daemonResponse.on("error", () => resolve(null));
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => resolve(null));
  });

/** An abort signal that fires once `response` closes, the page gone. */
const closeSignalOf = (response: http.ServerResponse): AbortSignal => {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  return controller.signal;
};

/** The open Session's key in the daemon's raw lookup answer, or `null`. */
const openSessionKeyOf = (answer: string): string | null => {
  try {
    return openSessionKeyIn(JSON.parse(answer));
  } catch {
    return null;
  }
};

/**
 * Answer the overlay's "is a Session open for this origin?" with the daemon's
 * `GET /apps/session` answer for `origin`. The overlay asks every second while
 * it rests as the dormant badge, so a daemon that is not running, or not
 * answering in time, is still a `200` rather than a `502` - a failed request
 * would print an error in the app's console that the page cannot suppress -
 * but one whose body says the daemon itself did not answer, so the badge can
 * tell "no daemon" from "no Session".
 */
export const answerSessionLookup = (
  response: http.ServerResponse,
  port: number,
  origin: string,
): void => {
  lookupSession(port, origin, closeSignalOf(response)).then((answer) => {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(answer ?? noDaemonAnswer([port]));
    }
  });
};

/**
 * Forward a Session-scoped request for `key` to the daemon as `path`, but only
 * when `key` is the Session open for `origin`, the page's own; any other key,
 * or no open Session, is a `404 RouteNotRelayed`, the same as a route the relay
 * does not know, and a line through `warn` for the dev server's log.
 */
export const relayToOwnSession = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  port: number,
  origin: string,
  key: string,
  path: string,
  warn: (message: string) => void,
): void => {
  lookupSession(port, origin, closeSignalOf(response)).then((answer) => {
    if (response.headersSent || response.destroyed) {
      return;
    }
    if (answer === null || openSessionKeyOf(answer) !== key) {
      warn(
        `[intervu] refused ${request.method ?? "GET"} ${relayPrefix}${path}: Session ${key} is not the Session open for the page origin ${origin}`,
      );
      sendError(
        response,
        404,
        "RouteNotRelayed",
        `${request.method ?? "GET"} ${relayPrefix}${path} is not a route of the Session open for ${origin}`,
      );
      return;
    }
    relayToDaemon(request, response, port, path);
  });
};
