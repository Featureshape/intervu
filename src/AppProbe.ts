import { Effect } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { AppUrl } from "./AppUrl.ts";
import { AppUnreachable } from "./Errors.ts";
import { Health } from "./Protocol.ts";
import { relayPrefix } from "./vite/relayPaths.ts";

/**
 * What `intervu <url>` checks about the running app before and after it opens
 * the Session: whether anything answers at the URL, and whether the
 * `intervu/vite` plugin's relay answers beside it.
 */

/** How long the app has to answer before it counts as unreachable. */
const answerTimeout = "5 seconds";

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
    Effect.timeout(answerTimeout),
    Effect.mapError(() => new AppUnreachable({ url: app.url })),
  );
});

/**
 * Whether the `intervu/vite` plugin answers on `origin`: its relay forwards
 * `/__intervu/health` to the daemon, so only the daemon's own health body
 * counts. A dev server without the plugin answers that path with its HTML
 * fallback, which does not decode as `Health`.
 */
export const pluginAnswers = Effect.fn("AppProbe.pluginAnswers")(function* (
  origin: string,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(HttpClientRequest.get(`${origin}${relayPrefix}/health`))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
      Effect.timeout(answerTimeout),
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    );
});
