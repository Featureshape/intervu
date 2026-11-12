import {
  Duration,
  Effect,
  FileSystem,
  Filter,
  Layer,
  Option,
  Path,
  Stream,
} from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { AppConfig } from "./AppConfig.ts";
import * as ArtifactAssets from "./ArtifactAssets.ts";
import { ArtifactWatcher } from "./ArtifactWatcher.ts";
import { BrowserAssets } from "./BrowserAssets.ts";
import { DaemonBoundPort, DaemonIdentity } from "./DaemonIdentity.ts";
import { appSessionPath, pluginReportPath } from "./DaemonRoutes.ts";
import * as FeedbackWait from "./FeedbackWait.ts";
import { PluginRegistry } from "./PluginRegistry.ts";
import {
  AppSessionRequest,
  AppSessionResponse,
  EndRequest,
  EndResponse,
  EndRiderRequest,
  OpenSessionRequest,
  PluginReportRequest,
  PollRequest,
  PollResponse,
  ReplyRequest,
  ReplyResponse,
  StatusResponse,
  StatusSession,
  ValidFeedback,
} from "./Protocol.ts";
import { type Session, SessionKey } from "./Session.ts";
import {
  ConversationAppended,
  FeedbackQueued,
  SessionEnded,
  SessionHub,
} from "./SessionHub.ts";
import { SessionStore } from "./SessionStore.ts";
import * as Sse from "./Sse.ts";
import { isWebOrigin, WaitingOrigins } from "./WaitingOrigins.ts";

/**
 * The daemon's HTTP surface (issues #3, #4). Routes are total - each handler
 * maps its own failures to a response so the served layer carries no
 * request-scoped error markers. The browser-opened URL is the stable `/s/:key`;
 * it now serves the chrome (top bar + conversation panel) wrapping the artifact,
 * which renders in a sandboxed opaque-origin iframe at `/s/:key/a/` (ADR 0003).
 */

const notFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status: 404 });

/**
 * Resolve the `:key` route param to its Session, replying with a uniform `404`
 * for an unknown (or missing) key. The continuation is total: it maps its own
 * IO failures to a response, so the route never leaks an error into the layer.
 */
const withSession = <R>(
  use: (
    session: Session,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
) =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const params = yield* HttpRouter.params;
    const rawKey = params.key;
    if (rawKey === undefined) {
      return notFound();
    }
    const session = yield* store.get(SessionKey.make(rawKey));
    return yield* Option.match(session, {
      onNone: () => Effect.succeed(notFound()),
      onSome: use,
    });
  });

/**
 * `withSession` for the routes that serve an artifact's file - its chrome page,
 * its bytes and their sibling assets. An `app` Session has no file behind its
 * handle (the handle is an origin, ADR 0022), so it gets the same `404` as an
 * unknown key rather than a read of a path that is not one.
 */
const withArtifactSession = <R>(
  use: (
    session: Session,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
) =>
  withSession((session) =>
    session.kind === "artifact" ? use(session) : Effect.succeed(notFound()),
  );

const healthRoute = HttpRouter.add(
  "GET",
  "/health",
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const identity = yield* DaemonIdentity;
    return HttpServerResponse.jsonUnsafe({
      ok: true,
      version: config.version,
      stateDir: config.stateDir,
      instanceId: identity.instanceId,
    });
  }),
);

const sessionsRoute = HttpRouter.add(
  "POST",
  "/sessions",
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const body = yield* HttpServerRequest.schemaBodyJson(OpenSessionRequest);
    const session = yield* store.open(body.path, body.kind);
    return HttpServerResponse.jsonUnsafe({
      key: session.key,
      path: session.path,
      status: session.status,
      kind: session.kind,
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("POST /sessions failed", error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

/**
 * The in-page overlay's question, relayed by the `intervu/vite` plugin: is an
 * `app` Session open for this dev-server origin (ADR 0022)? A lookup without
 * create, so a page can never open a Session itself. A malformed query is a
 * `400`; an origin no `app` Session was opened for answers `session: null`.
 */
const appSessionRoute = HttpRouter.add(
  "GET",
  appSessionPath,
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const waiting = yield* WaitingOrigins;
    const query =
      yield* HttpServerRequest.schemaSearchParams(AppSessionRequest);
    const session = yield* store.getByPath(query.origin);
    const app = Option.filter(session, (found) => found.kind === "app");
    // The waiting-origin memory rides the lookups that already happen: a
    // `session: null` answer for a web origin records it as waiting, and a
    // lookup that finds its open Session clears it. Non-origin queries (an
    // artifact path, a stray client) are never worth remembering.
    yield* Option.match(app, {
      onNone: () =>
        isWebOrigin(query.origin) ? waiting.miss(query.origin) : Effect.void,
      onSome: (found) =>
        found.status === "open" ? waiting.found(query.origin) : Effect.void,
    });
    return HttpServerResponse.jsonUnsafe(
      AppSessionResponse.make({
        session: Option.match(app, {
          onNone: () => null,
          onSome: (found) => ({
            key: found.key,
            status: found.status,
            lastActivityAt: found.lastActivityAt,
          }),
        }),
      }),
    );
  }).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    ),
    Effect.catch((error) =>
      Effect.logError(`GET ${appSessionPath} failed`, error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

/**
 * The plugin's push channel: one `intervu/vite` plugin reporting its own
 * origin, the page origins it has seen succeed, and its refusal tallies. The
 * registry keeps it in memory only. A malformed report is a `400`; an old
 * daemon has no such route, and the plugin reads that `404` as "old daemon"
 * and keeps relaying.
 */
const pluginReportRoute = HttpRouter.add(
  "POST",
  pluginReportPath,
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    const body = yield* HttpServerRequest.schemaBodyJson(PluginReportRequest);
    yield* registry.report(body);
    return HttpServerResponse.jsonUnsafe({ ok: true });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`POST ${pluginReportPath} rejected`, error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 400 })),
      ),
    ),
  ),
);

/**
 * The live diagnostics `intervu status` renders: the daemon describing itself
 * (version, port, state dir), every Session with its Presence, and every
 * plugin that has reported in. The Home view stays offline (ADR 0013); this
 * is the one route that answers "what is intervu seeing right now?".
 */
const statusRoute = HttpRouter.add(
  "GET",
  "/status",
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const bound = yield* DaemonBoundPort;
    const store = yield* SessionStore;
    const hub = yield* SessionHub;
    const registry = yield* PluginRegistry;
    const waiting = yield* WaitingOrigins;
    const sessions = yield* store.list;
    const withPresence = yield* Effect.forEach(sessions, (session) =>
      hub.presence(session.key).pipe(
        Effect.map((presence) =>
          StatusSession.make({
            key: session.key,
            kind: session.kind,
            handle: session.path,
            status: session.status,
            presence,
            lastActivityAt: session.lastActivityAt,
          }),
        ),
      ),
    );
    const plugins = yield* registry.sightings;
    const waitingOrigins = yield* waiting.list;
    return yield* HttpServerResponse.schemaJson(StatusResponse)(
      StatusResponse.make({
        version: config.version,
        port: bound.port,
        stateDir: config.stateDir,
        sessions: withPresence,
        plugins,
        waitingOrigins,
      }),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("GET /status failed", error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

/** The stable opened URL: the chrome page wrapping the artifact's iframe. */
const chromeRoute = HttpRouter.add(
  "GET",
  "/s/:key",
  withArtifactSession((session) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const watcher = yield* ArtifactWatcher;
      const artifactVersion = yield* watcher.version(session.path);
      const html = ArtifactAssets.renderChrome({
        key: session.key,
        filename: path.basename(session.path),
        path: session.path,
        artifactVersion: Option.getOrNull(artifactVersion),
      });
      return HttpServerResponse.text(html, { contentType: "text/html" });
    }),
  ),
);

/**
 * The shared artifact-and-assets prefix. `HttpRouter` registers a `/*` route at
 * both `/s/:key/a/*` and `/s/:key/a`, so the iframe `src` `/s/:key/a/` lands
 * here with an empty remainder and serves the artifact HTML (SDK injected); a
 * non-empty remainder resolves a sibling asset, confined to the artifact
 * directory by the pure path-safety check. A rejection and a missing asset both
 * return `404`, so a response never reveals whether an out-of-directory path
 * exists.
 */
const artifactRoute = HttpRouter.add(
  "GET",
  "/s/:key/a/*",
  withArtifactSession((session) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const params = yield* HttpRouter.params;
      const remainder = params["*"] ?? "";

      if (remainder === "") {
        return yield* fs.readFileString(session.path).pipe(
          Effect.map((html) =>
            HttpServerResponse.text(ArtifactAssets.injectSdk(html), {
              contentType: "text/html",
            }),
          ),
          Effect.catch((error) =>
            Effect.logError("GET /s/:key/a/ read failed", error).pipe(
              Effect.as(HttpServerResponse.empty({ status: 500 })),
            ),
          ),
        );
      }

      const dir = path.dirname(session.path);
      const resolution = ArtifactAssets.resolveAsset(path, dir, remainder);
      if (resolution._tag === "Rejected") {
        return notFound();
      }
      return yield* fs.readFile(resolution.path).pipe(
        Effect.map((bytes) =>
          HttpServerResponse.uint8Array(bytes, {
            contentType: ArtifactAssets.contentTypeFor(path, resolution.path),
          }),
        ),
        Effect.catch((error) =>
          Effect.logDebug("GET /s/:key/a/* asset read failed", error).pipe(
            Effect.as(notFound()),
          ),
        ),
      );
    }),
  ),
);

/** The artifact's raw, un-injected bytes - the "copy DOM snapshot" source. */
const sourceRoute = HttpRouter.add(
  "GET",
  "/s/:key/source",
  withArtifactSession((session) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(session.path).pipe(
        Effect.map((html) =>
          HttpServerResponse.text(html, { contentType: "text/html" }),
        ),
        Effect.catch((error) =>
          Effect.logError("GET /s/:key/source read failed", error).pipe(
            Effect.as(HttpServerResponse.empty({ status: 500 })),
          ),
        ),
      );
    }),
  ),
);

/**
 * The chrome's Send target: queue one Feedback for the Session and signal any
 * waiting poll. The body is re-validated against `ValidFeedback` (non-empty
 * message or >=1 annotation), so a malformed or empty submission is a `400` and
 * the queue never holds an empty Feedback. `queueFeedback` then `publish` order
 * is load-bearing: a poll that subscribed first sees the signal and drains.
 *
 * A Send also appends the human's message to the Conversation and publishes a
 * `ConversationAppended` (ADR 0010), so the chrome renders it from the SSE
 * stream rather than an optimistic local insert. The two events are distinct:
 * `FeedbackQueued` stays payload-free (the poll's wake-signal; ADR 0009) and the
 * thread frame carries the entry. `annotationCount` lets the chrome render an
 * annotation-only Feedback (empty message) as a count, not a blank bubble.
 *
 * Feedback to an `ended` Session is rejected with `409` (defense-in-depth; the
 * chrome already removes the composer on end, so this only fires on a stale or
 * crafted request), so the queue never holds feedback for a closed review.
 */
const feedbackRoute = HttpRouter.add(
  "POST",
  "/s/:key/feedback",
  withSession((session) =>
    Effect.gen(function* () {
      if (session.status === "ended") {
        return HttpServerResponse.empty({ status: 409 });
      }
      const store = yield* SessionStore;
      const hub = yield* SessionHub;
      const feedback = yield* HttpServerRequest.schemaBodyJson(ValidFeedback);
      yield* store.touch(session.key);
      yield* store.queueFeedback(session.key, feedback);
      yield* hub.publish(session.key, new FeedbackQueued());
      const entry = yield* store.appendConversation(session.key, {
        role: "human",
        text: feedback.message,
        annotationCount: feedback.annotations.length,
      });
      yield* hub.publish(session.key, new ConversationAppended({ entry }));
      return HttpServerResponse.jsonUnsafe({ queued: true });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("POST /s/:key/feedback rejected", error).pipe(
          Effect.as(HttpServerResponse.empty({ status: 400 })),
        ),
      ),
    ),
  ),
);

/**
 * Append a non-blank Agent-reply to the Conversation and push it to the chrome
 * over the SSE stream. A blank message is a no-op; returns whether one posted.
 */
const postAgentReply = (key: SessionKey, message: string) =>
  Effect.gen(function* () {
    const text = message.trim();
    if (text.length === 0) {
      return false;
    }
    const store = yield* SessionStore;
    const hub = yield* SessionHub;
    const entry = yield* store.appendConversation(key, {
      role: "agent",
      text,
      annotationCount: 0,
    });
    yield* hub.publish(key, new ConversationAppended({ entry }));
    return true;
  });

/**
 * The agent's long-poll (ADR 0009): path-addressed and lookup-without-create, so
 * an unopened path is a structured `404` (`ReviewNotOpen`) rather than a silent
 * spawn. For an open Session it holds the request, draining queued Feedback once
 * the human sends (or returning the `timedOut` marker when the request set a
 * bound). `Effect.scoped` ties the hub subscription to the request: a killed
 * poll interrupts this fiber and releases it.
 *
 * A non-blank `agentReply` is posted into the Conversation (ADR 0010) before the
 * wait begins, so the reply reaches the chrome over the SSE stream immediately -
 * not on this response, which stays held open for minutes. A blank or absent
 * reply is a no-op and just polls.
 *
 * The settle now has three reasons (ADR 0011): drained feedback, `timedOut`, or
 * the Session `ended` (which may carry a final feedback in the same response when
 * the human used Send & end). A poll on an already-`ended` Session returns at once.
 */
const pollRoute = HttpRouter.add(
  "POST",
  "/poll",
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const request = yield* HttpServerRequest.schemaBodyJson(PollRequest);
    const session = yield* store.getByPath(request.path);
    return yield* Option.match(session, {
      onNone: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { _tag: "ReviewNotOpen", path: request.path },
            { status: 404 },
          ),
        ),
      onSome: (open) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* store.touch(open.key);
            yield* postAgentReply(open.key, request.agentReply ?? "");
            const outcome = yield* FeedbackWait.wait(open.key, {
              timeout: Option.map(
                Option.fromNullishOr(request.timeoutSeconds),
                Duration.seconds,
              ),
            });
            return yield* HttpServerResponse.schemaJson(PollResponse)(
              new PollResponse({
                timedOut: outcome.timedOut,
                ended: outcome.ended,
                feedback: outcome.feedback,
              }),
            );
          }),
        ),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("POST /poll failed", error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

/**
 * Post an Agent-reply without waiting (ADR 0020), so the agent can acknowledge
 * feedback or answer a question while another poll stays open, or without editing
 * the artifact at all. Path-addressed and lookup-without-create like `POST /end`.
 * An ended Session posts nothing, since its chrome no longer listens, and says so.
 */
const replyRoute = HttpRouter.add(
  "POST",
  "/reply",
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const request = yield* HttpServerRequest.schemaBodyJson(ReplyRequest);
    const session = yield* store.getByPath(request.path);
    return yield* Option.match(session, {
      onNone: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { _tag: "ReviewNotOpen", path: request.path },
            { status: 404 },
          ),
        ),
      onSome: (open) =>
        Effect.gen(function* () {
          const ended = open.status === "ended";
          if (!ended) {
            yield* store.touch(open.key);
          }
          const posted = ended
            ? false
            : yield* postAgentReply(open.key, request.message);
          return yield* HttpServerResponse.schemaJson(ReplyResponse)(
            new ReplyResponse({ posted, ended }),
          );
        }),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("POST /reply failed", error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

/**
 * The single End core behind both end routes (ADR 0011 / 0012). It applies the
 * optional final-feedback rider and the status flip to the store *before*
 * publishing `SessionEnded`, so a waiting poll drains the feedback and reads
 * `ended` in one settle (the store, not the signal, is the source of truth). A
 * rider also appends the human's message to the Conversation and publishes a
 * `ConversationAppended` first, so the chrome renders the final bubble before it
 * reacts to the ended frame (SSE frames are ordered on the one connection).
 *
 * Ending an already-`ended` Session is an idempotent no-op: the rider is dropped
 * (feedback to a closed review is rejected) and no `SessionEnded` is re-emitted -
 * a poll on an already-ended Session has long since returned `ended`.
 */
const endSession = (
  session: Session,
  rider: Option.Option<typeof ValidFeedback.Type>,
) =>
  Effect.gen(function* () {
    if (session.status === "ended") {
      return;
    }
    const store = yield* SessionStore;
    const hub = yield* SessionHub;
    yield* Option.match(rider, {
      onNone: () => Effect.void,
      onSome: (feedback) =>
        Effect.gen(function* () {
          yield* store.queueFeedback(session.key, feedback);
          const entry = yield* store.appendConversation(session.key, {
            role: "human",
            text: feedback.message,
            annotationCount: feedback.annotations.length,
          });
          yield* hub.publish(session.key, new ConversationAppended({ entry }));
        }),
    });
    yield* store.end(session.key);
    yield* hub.publish(session.key, new SessionEnded());
  });

const endedResponse = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(new EndResponse({ ended: true }));

/**
 * The chrome's End target (ADR 0011): key-addressed with an optional
 * `ValidFeedback` rider. An empty/absent rider is a plain End (top-bar control);
 * a present rider is Send & end. A malformed rider is a `400`; the status flip
 * itself is idempotent, so the response is always the ended marker.
 */
const endChromeRoute = HttpRouter.add(
  "POST",
  "/s/:key/end",
  withSession((session) =>
    Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(EndRiderRequest);
      yield* endSession(session, Option.fromNullishOr(body.feedback));
      return endedResponse();
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("POST /s/:key/end rejected", error).pipe(
          Effect.as(HttpServerResponse.empty({ status: 400 })),
        ),
      ),
    ),
  ),
);

/**
 * The agent's End (ADR 0011 / 0012): path-addressed and lookup-without-create,
 * mirroring `poll`, so an unopened path is a structured `404` (`ReviewNotOpen`)
 * rather than a silent spawn. No final-feedback rider - the terminal end is plain.
 */
const endRoute = HttpRouter.add(
  "POST",
  "/end",
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const request = yield* HttpServerRequest.schemaBodyJson(EndRequest);
    const session = yield* store.getByPath(request.path);
    return yield* Option.match(session, {
      onNone: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { _tag: "ReviewNotOpen", path: request.path },
            { status: 404 },
          ),
        ),
      onSome: (open) =>
        endSession(open, Option.none()).pipe(Effect.as(endedResponse())),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("POST /end failed", error).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

/** The `: ping` heartbeat cadence on the SSE stream (ADR 0010 insurance). */
const SSE_PING_INTERVAL = Duration.seconds(20);

/**
 * The single server-to-browser SSE channel (ADR 0010): one `text/event-stream`
 * response multiplexing live-reload, Conversation appends, and Presence. On
 * connect it replays the Conversation newer than `Last-Event-ID` plus the current
 * Presence, then streams live hub frames merged with a `: ping` heartbeat;
 * `FeedbackQueued` is filtered out so the poll's wake-signal never reaches the
 * browser. The hub subscription and the watcher ref-count ride the body stream's
 * scope (`Stream.unwrap` manages it), released when `BunHttpServer` interrupts
 * the handler on client disconnect - the same abort wiring as the poll (ADR
 * 0009). The handler's context is captured and re-provided to the body, which the
 * server runs after the handler returns. An `app` Session's in-page panel reads
 * the same stream through the `intervu/vite` relay; it runs no watcher and gets
 * no `ArtifactReloaded`, since Vite's HMR reloads the app.
 */
const eventsRoute = HttpRouter.add(
  "GET",
  "/s/:key/events",
  withSession((session) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<
        SessionHub | SessionStore | ArtifactWatcher
      >();
      const request = yield* HttpServerRequest.HttpServerRequest;
      const afterSeq = Sse.parseLastEventId(request.headers["last-event-id"]);

      const body = Stream.unwrap(
        Effect.gen(function* () {
          const hub = yield* SessionHub;
          const store = yield* SessionStore;
          const watcher = yield* ArtifactWatcher;
          const subscription = yield* hub.subscribe(session.key);
          // An `app` Session's handle is an origin, not a file: Vite's HMR
          // reloads the app, so there is nothing to watch and no version.
          const version =
            session.kind === "artifact"
              ? yield* watcher.track(session.key, session.path).pipe(
                  // Read after `track`, so an edit is either in this version
                  // or arrives live. The chrome ignores a version it already
                  // shows (ADR 0020).
                  Effect.andThen(watcher.version(session.path)),
                )
              : Option.none<string>();
          const replay = yield* store.conversationSince(session.key, afterSeq);
          const presence = yield* hub.presence(session.key);
          // Subscribe-then-check (mirror of the poll): read the status after
          // subscribing, so a connect to an already-`ended` Session replays the
          // ended frame, while an end that races the connect arrives live.
          const current = yield* store.get(session.key);
          const ended = Option.match(current, {
            onNone: () => false,
            onSome: (s) => s.status === "ended",
          });
          const initial = Stream.fromIterable([
            ...replay.map(Sse.conversationFrame),
            Sse.presenceFrame(presence),
            ...Option.match(version, {
              onNone: () => [],
              onSome: (current) => [Sse.reloadFrame(current)],
            }),
            ...(ended ? [Sse.endedFrame()] : []),
          ]);
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filterMap(Filter.fromPredicateOption(Sse.liveFrame)),
          );
          const heartbeat = Stream.tick(SSE_PING_INTERVAL).pipe(
            Stream.map(() => Sse.PING_FRAME),
          );
          return Stream.concat(initial, Stream.merge(live, heartbeat));
        }),
      ).pipe(Stream.encodeText, Stream.provideContext(services));

      return HttpServerResponse.stream(body, {
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    }),
  ),
);

/**
 * The global in-iframe SDK, injected into every artifact, plus the chrome's own
 * controller and stylesheet. All three are built from `src/sdk` + `src/chrome`
 * and served from `BrowserAssets` (ADR 0007); the routes are stable, only the
 * served bytes vary between the dev build and the baked bundle.
 */
const sdkRoute = HttpRouter.add(
  "GET",
  "/sdk.js",
  Effect.gen(function* () {
    const assets = yield* BrowserAssets;
    return HttpServerResponse.text(assets.sdkJs, {
      contentType: "text/javascript",
    });
  }),
);

const chromeScriptRoute = HttpRouter.add(
  "GET",
  "/chrome.js",
  Effect.gen(function* () {
    const assets = yield* BrowserAssets;
    return HttpServerResponse.text(assets.chromeJs, {
      contentType: "text/javascript",
    });
  }),
);

const chromeStyleRoute = HttpRouter.add(
  "GET",
  "/chrome.css",
  Effect.gen(function* () {
    const assets = yield* BrowserAssets;
    return HttpServerResponse.text(assets.chromeCss, {
      contentType: "text/css",
    });
  }),
);

/**
 * The served HTTP app layer. Requires the actual `HttpServer` (bound by
 * `BunHttpServer.layer`) plus the route dependencies, all supplied by the
 * daemon's layer composition.
 */
export const layer = HttpRouter.serve(
  Layer.mergeAll(
    healthRoute,
    sessionsRoute,
    appSessionRoute,
    pluginReportRoute,
    statusRoute,
    chromeRoute,
    artifactRoute,
    sourceRoute,
    feedbackRoute,
    pollRoute,
    replyRoute,
    endChromeRoute,
    endRoute,
    eventsRoute,
    sdkRoute,
    chromeScriptRoute,
    chromeStyleRoute,
  ),
);
