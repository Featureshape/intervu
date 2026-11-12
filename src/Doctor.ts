import { Effect } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import type { AppUrl } from "./AppUrl.ts";
import { hasField } from "./hasField.ts";
import { guardRefusalIn, plainWordsOf } from "./vite/guardRefusal.ts";
import { relayPrefix, sessionPath } from "./vite/relayPaths.ts";
import {
  openSessionKeyIn,
  unreachedDaemonPortsIn,
} from "./vite/sessionAnswer.ts";

/**
 * `intervu doctor <url>`: replay the overlay's exact Session lookup -
 * `GET <origin>/__intervu/session?origin=<origin>` with the `Origin` header
 * set - and read the per-check verdict out of the one answer. A plain `curl`
 * without `?origin=` once gave a false pass that cost real debugging time;
 * doctor cannot produce that pass, because it always sends what the overlay
 * sends. The classification is pure, pinned by unit tests; only the two HTTP
 * requests live at the edges.
 */

/** One check's verdict: passed, failed with a fix hint, or not reached. */
export type CheckResult =
  | { readonly result: "pass"; readonly detail: string }
  | { readonly result: "fail"; readonly detail: string; readonly hint: string }
  | { readonly result: "skipped"; readonly detail: string };

/** The named checks doctor prints, in the order it prints them. */
export interface Diagnosis {
  readonly app: CheckResult;
  readonly plugin: CheckResult;
  readonly guard: CheckResult;
  readonly daemon: CheckResult;
  readonly session: CheckResult;
}

const skipped = (detail: string): CheckResult => ({
  result: "skipped",
  detail,
});

const notReached = skipped("not checked - fix the failing check above first");

/** Where the reverse-proxy recipe lives, named by the guard's fix hint. */
const proxyRecipe = 'the README section "Behind a reverse proxy"';

/**
 * Classify the lookup answer into the four checks it can settle. `body` is
 * the decoded JSON, or `null` when the answer was not JSON at all - a dev
 * server without the plugin falls through to its HTML page.
 */
export const diagnoseLookup = (
  origin: string,
  status: number,
  body: unknown,
): Pick<Diagnosis, "plugin" | "guard" | "daemon" | "session"> => {
  if (body === null || typeof body !== "object") {
    return {
      plugin: {
        result: "fail",
        detail: `nothing that speaks intervu answered ${relayPrefix}${sessionPath} (HTTP ${status})`,
        hint: `add \`import { intervu } from "intervu/vite"\` and \`intervu()\` to the plugins in vite.config.ts, then restart the dev server`,
      },
      guard: notReached,
      daemon: notReached,
      session: notReached,
    };
  }
  const plugin: CheckResult = {
    result: "pass",
    detail: "the intervu Vite plugin answered the relay route",
  };
  if (status === 403) {
    const refusal = guardRefusalIn(body);
    const reason =
      refusal === null
        ? "the dev server refused the request (an older intervu names no reason)"
        : `${refusal.reason} - ${plainWordsOf(refusal.reason)}${
            refusal.pageOrigin === undefined
              ? ""
              : ` (page origin presented: ${refusal.pageOrigin})`
          }`;
    return {
      plugin,
      guard: {
        result: "fail",
        detail: reason,
        hint: `forward the browser's Host (or X-Forwarded-Host) and X-Forwarded-Proto through the proxy, and add the hostname to server.allowedHosts in vite.config.ts - see ${proxyRecipe}; the dev server log has the full comparison`,
      },
      daemon: notReached,
      session: notReached,
    };
  }
  if (status !== 200) {
    return {
      plugin,
      guard: {
        result: "fail",
        detail: `the relay answered HTTP ${status}, which the overlay cannot read`,
        hint: "restart the dev server; if it persists, update the intervu/vite plugin",
      },
      daemon: notReached,
      session: notReached,
    };
  }
  const guard: CheckResult = {
    result: "pass",
    detail: "the request passed the dev server's origin guard",
  };
  const ports = unreachedDaemonPortsIn(body);
  if (ports !== null) {
    return {
      plugin,
      guard,
      daemon: {
        result: "fail",
        detail: `the plugin found no daemon on port ${ports.join(", ")}`,
        hint: `run 'intervu ${origin}' in the agent's shell to start one, and start the dev server with the same INTERVU_PORT when it is set`,
      },
      session: notReached,
    };
  }
  const daemon: CheckResult = {
    result: "pass",
    detail: "the plugin reached a daemon",
  };
  const key = openSessionKeyIn(body);
  if (key !== null) {
    return {
      plugin,
      guard,
      daemon,
      session: {
        result: "pass",
        detail: `Session ${key} is open for ${origin}`,
      },
    };
  }
  const ended =
    hasField(body, "session") &&
    hasField(body.session, "status") &&
    body.session.status === "ended";
  return {
    plugin,
    guard,
    daemon,
    session: {
      result: "fail",
      detail: ended
        ? `the Session for ${origin} has ended`
        : `no Session is open for ${origin}`,
      hint: `run 'intervu ${origin}' to open one`,
    },
  };
};

/** How long each doctor request may take before its check fails. */
const answerTimeout = "5 seconds";

/** Accept any TLS certificate, as the probes do: dev CAs are the norm. */
const probeInit: BunFetchRequestInit = { tls: { rejectUnauthorized: false } };

const withProbeInit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, FetchHttpClient.RequestInit, probeInit);

/**
 * Run the two requests and fold their answers into the five checks: one GET
 * of the app's URL (any HTTP answer passes), and the overlay's exact lookup.
 * Total: every failure becomes a failing check, never an error.
 */
export const diagnose = Effect.fn("Doctor.diagnose")(function* (app: AppUrl) {
  const client = yield* HttpClient.HttpClient;

  const reachable = yield* client.execute(HttpClientRequest.get(app.url)).pipe(
    withProbeInit,
    Effect.timeout(answerTimeout),
    Effect.map((response) => ({
      result: "pass" as const,
      detail: `${app.url} answered HTTP ${response.status}`,
    })),
    Effect.orElseSucceed(() => ({
      result: "fail" as const,
      detail: `nothing answered at ${app.url} within ${answerTimeout}`,
      hint: "start the app's dev server, or check the URL and the network path to it",
    })),
  );
  if (reachable.result === "fail") {
    return {
      app: reachable,
      plugin: notReached,
      guard: notReached,
      daemon: notReached,
      session: notReached,
    };
  }

  const lookupUrl = `${app.origin}${relayPrefix}${sessionPath}?${new URLSearchParams(
    { origin: app.origin },
  )}`;
  const request = HttpClientRequest.get(lookupUrl).pipe(
    HttpClientRequest.setHeader("origin", app.origin),
  );
  const looked = yield* client.execute(request).pipe(
    Effect.flatMap((response) =>
      response.json.pipe(
        Effect.map((body) => diagnoseLookup(app.origin, response.status, body)),
        Effect.orElseSucceed(() =>
          diagnoseLookup(app.origin, response.status, null),
        ),
      ),
    ),
    withProbeInit,
    Effect.timeout(answerTimeout),
    Effect.orElseSucceed(() => ({
      plugin: {
        result: "fail" as const,
        detail: `${relayPrefix}${sessionPath} did not answer within ${answerTimeout}`,
        hint: "restart the dev server, then re-run the doctor",
      },
      guard: notReached,
      daemon: notReached,
      session: notReached,
    })),
  );

  return { app: reachable, ...looked };
});

/** How many of a diagnosis's checks failed. */
export const failedCount = (diagnosis: Diagnosis): number =>
  [
    diagnosis.app,
    diagnosis.plugin,
    diagnosis.guard,
    diagnosis.daemon,
    diagnosis.session,
  ].filter((check) => check.result === "fail").length;
