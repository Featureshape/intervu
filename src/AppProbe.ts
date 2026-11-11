import { Effect } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import type { AppUrl } from "./AppUrl.ts";
import { AppUnreachable } from "./Errors.ts";
import { hasField } from "./hasField.ts";
import { relayPrefix, sessionPath } from "./vite/relayPaths.ts";
import { openSessionKeyIn } from "./vite/sessionAnswer.ts";

/**
 * What `intervu <url>` checks about the running app before and after it opens
 * the Session: whether anything answers at the URL, and whether the
 * `intervu/vite` plugin's relay answers beside it and sees the Session.
 */

/** How long the app has to answer before it counts as unreachable. */
const answerTimeout = "5 seconds";

/**
 * Fetch options for the probes: accept any TLS certificate. A dev server on
 * https usually serves a certificate from a local CA (mkcert, a corporate
 * proxy) that Bun does not trust, because Bun reads its own CA store, not the
 * system's. The probes only ask whether something answers and read intervu's
 * own JSON back; they send nothing secret, so an untrusted certificate is no
 * reason to call a running app unreachable.
 */
const probeInit: BunFetchRequestInit = { tls: { rejectUnauthorized: false } };

/** Run a probe with `probeInit` as the fetch client's default options. */
const withProbeInit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, FetchHttpClient.RequestInit, probeInit);

/**
 * Succeed when the app answers `app.url` with any HTTP response, whatever its
 * status: a 404 or a 500 is still a dev server that is up. A refused connection
 * or no answer within the timeout fails with `AppUnreachable`.
 */
export const requireAnswer = Effect.fn("AppProbe.requireAnswer")(function* (
  app: AppUrl,
) {
  const client = yield* HttpClient.HttpClient;
  yield* client.execute(HttpClientRequest.get(app.url)).pipe(
    withProbeInit,
    Effect.timeout(answerTimeout),
    Effect.mapError(() => new AppUnreachable({ url: app.url })),
  );
});

/**
 * What the `intervu/vite` plugin's relay said when asked, at the app's own
 * origin, which Session is open for that origin:
 *
 * - `sees-session`: it answered with the Session `intervu <url>` just opened,
 *   so the overlay in the human's tab will find it.
 * - `other-session`: it answered, but not with that Session - it reaches
 *   another daemon (a different `INTERVU_PORT`).
 * - `refused`: it turned the request away as not from the dev server's own
 *   origin; the dev server's log says why.
 * - `missing`: nothing that speaks intervu answered; the dev server has no
 *   plugin.
 */
export type PluginAnswer =
  | "sees-session"
  | "other-session"
  | "refused"
  | "missing";

/** Whether a relay answer is its `403` for a request it refused. */
const isRefusal = (status: number, body: unknown): boolean =>
  status === 403 &&
  hasField(body, "error") &&
  hasField(body.error, "tag") &&
  body.error.tag === "ForeignOrigin";

/**
 * Ask the plugin's relay at `app.origin` the same question the overlay asks -
 * which Session is open for this origin - and compare its answer with `key`,
 * the Session just opened. A dev server without the plugin answers that path
 * with its HTML fallback, which is not JSON.
 */
export const pluginAnswers = Effect.fn("AppProbe.pluginAnswers")(function* (
  app: AppUrl,
  key: string,
) {
  const client = yield* HttpClient.HttpClient;
  const url = `${app.origin}${relayPrefix}${sessionPath}?${new URLSearchParams({ origin: app.origin })}`;
  return yield* client.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.json, (body): PluginAnswer => {
        if (isRefusal(response.status, body)) {
          return "refused";
        }
        if (response.status !== 200 || !hasField(body, "session")) {
          return "missing";
        }
        return openSessionKeyIn(body) === key
          ? "sees-session"
          : "other-session";
      }),
    ),
    withProbeInit,
    Effect.timeout(answerTimeout),
    Effect.match({
      onFailure: (): PluginAnswer => "missing",
      onSuccess: (answer) => answer,
    }),
  );
});
