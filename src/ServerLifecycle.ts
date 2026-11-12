import { openSync } from "node:fs";
import {
  Clock,
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Ref,
  Schedule,
  type Schema,
} from "effect";
import * as Context from "effect/Context";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { AppConfig } from "./AppConfig.ts";
import {
  DaemonNotRunning,
  ReviewNotOpen,
  ServerStartTimeout,
  StaleDaemon,
  StaleServerTakeover,
} from "./Errors.ts";
import {
  EndResponse,
  Health,
  PollResponse,
  ReplyResponse,
  StatusResponse,
} from "./Protocol.ts";
import { Session, type SessionKind } from "./Session.ts";

type EnsureError =
  | ServerStartTimeout
  | StaleServerTakeover
  | PlatformError.PlatformError
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

/**
 * Parse a `major.minor.patch` string into a numeric tuple, or `None` when it is
 * not three dot-separated integers (ADR 0015). Pre-release / build suffixes are
 * not modelled - the version is a controlled `0.0.0`-shaped string.
 */
const parseVersion = (
  version: string,
): Option.Option<readonly [number, number, number]> => {
  const parts = version.split(".");
  if (parts.length !== 3) {
    return Option.none();
  }
  const [major, minor, patch] = parts.map((part) => Number.parseInt(part, 10));
  return major !== undefined &&
    minor !== undefined &&
    patch !== undefined &&
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch)
    ? Option.some([major, minor, patch] as const)
    : Option.none();
};

/**
 * The takeover predicate (ADR 0015): is the running daemon strictly older than
 * this client? Compares the two versions as numeric `major.minor.patch` tuples;
 * an unparseable *running* version counts as stale (take over), while an
 * unparseable *client* version never evicts (defensive - our own version is the
 * controlled `0.0.0`-shaped string). Equal-or-newer is reused, so only a
 * strictly-newer client ever replaces a server.
 */
export const isStaleVersion = (
  runningVersion: string,
  clientVersion: string,
): boolean => {
  const running = parseVersion(runningVersion);
  if (Option.isNone(running)) {
    return true;
  }
  const client = parseVersion(clientVersion);
  if (Option.isNone(client)) {
    return false;
  }
  const [rMajor, rMinor, rPatch] = running.value;
  const [cMajor, cMinor, cPatch] = client.value;
  if (rMajor !== cMajor) {
    return rMajor < cMajor;
  }
  if (rMinor !== cMinor) {
    return rMinor < cMinor;
  }
  return rPatch < cPatch;
};

type PollError =
  | ReviewNotOpen
  | DaemonNotRunning
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

type ReplyError = EndError;

type EndError =
  | ReviewNotOpen
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

/**
 * The CLI's view of the daemon (ADR 0002): the CLI is a thin HTTP client that
 * ensures a healthy daemon exists - self-spawning `intervu server` detached when
 * absent - then opens or resumes a Session over HTTP. State lives entirely in the
 * daemon; this service never touches `SessionStore`.
 */
export class ServerLifecycle extends Context.Service<
  ServerLifecycle,
  {
    readonly ensure: Effect.Effect<Health, EnsureError>;
    readonly requireHealthy: Effect.Effect<
      Health,
      | DaemonNotRunning
      | StaleDaemon
      | HttpClientError.HttpClientError
      | Schema.SchemaError
    >;
    readonly signalStop: Effect.Effect<
      Option.Option<number>,
      PlatformError.PlatformError
    >;
    readonly openSession: (
      path: string,
      kind: SessionKind,
    ) => Effect.Effect<
      Session,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    readonly poll: (
      path: string,
      timeoutSeconds: Option.Option<number>,
      agentReply: Option.Option<string>,
    ) => Effect.Effect<PollResponse, PollError>;
    readonly reply: (
      path: string,
      message: string,
    ) => Effect.Effect<ReplyResponse, ReplyError>;
    readonly end: (path: string) => Effect.Effect<EndResponse, EndError>;
    readonly status: Effect.Effect<
      StatusResponse,
      | DaemonNotRunning
      | StaleDaemon
      | HttpClientError.HttpClientError
      | Schema.SchemaError
    >;
  }
>()("@intervu/ServerLifecycle") {
  static readonly layer = Layer.effect(
    ServerLifecycle,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;
      const urlOf = (port: number) => `http://${config.hostname}:${port}`;

      // The port my daemon answered on last, resolved once per command run:
      // `ensure`/`requireHealthy` set it and every later request uses it.
      const resolvedPort = yield* Ref.make(config.port);
      const baseUrl = Ref.get(resolvedPort).pipe(Effect.map(urlOf));

      // `BunHttpServer` binds the port before the routes are mounted and
      // answers `404` for about 250ms in between, so a `404` from a daemon
      // that is still starting is retried, briefly, rather than read as
      // nobody home. A refused connection fails fast with no retry, so a
      // ten-port scan of dead ports stays cheap.
      const isStarting = (
        error:
          | HttpClientError.HttpClientError
          | Schema.SchemaError
          | { readonly _tag: string },
      ) =>
        HttpClientError.isHttpClientError(error) &&
        error.reason._tag === "StatusCodeError" &&
        error.reason.response.status === 404;

      /** Whose daemon answers `port`, if any: `None` when nothing does. */
      const healthAt = (port: number): Effect.Effect<Option.Option<Health>> =>
        client.execute(HttpClientRequest.get(`${urlOf(port)}/health`)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
          Effect.timeout("1 second"),
          Effect.retry({
            while: isStarting,
            times: 20,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<Health>()),
        );

      /**
       * "Mine" means "same state dir". A daemon from before the identity
       * fields names none; it predates coexistence, so it is treated as the
       * single daemon it was - the version check then applies as always.
       */
      const isMine = (health: Health): boolean =>
        health.stateDir === undefined || health.stateDir === config.stateDir;

      // The client's memory of which range port its daemon bound, so later
      // commands in the same agent session find it first. Best-effort cache:
      // unreadable or stale contents just fall back to the scan.
      const readPortFile: Effect.Effect<Option.Option<number>> = fs
        .readFileString(config.portFile)
        .pipe(
          Effect.map((text) => {
            const port = Number.parseInt(text.trim(), 10);
            return config.ports.includes(port)
              ? Option.some(port)
              : Option.none<number>();
          }),
          Effect.orElseSucceed(() => Option.none<number>()),
        );

      const writePortFile = (port: number): Effect.Effect<void> =>
        fs.makeDirectory(config.stateDir, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(config.portFile, `${port}\n`)),
          Effect.catch((error) =>
            Effect.logWarning("could not persist the daemon port", error),
          ),
        );

      /** One daemon that is mine, found on the pinned port or the range. */
      interface FoundDaemon {
        readonly port: number;
        readonly health: Health;
      }

      /**
       * Find my daemon: the pinned port only when `INTERVU_PORT` is set
       * (behaviour: no range scan), else the cached port first and then the
       * range in order. A live daemon with another state dir is left alone -
       * never reused, never evicted.
       */
      const findMine: Effect.Effect<Option.Option<FoundDaemon>> = Effect.gen(
        function* () {
          const cached = config.portPinned
            ? Option.none<number>()
            : yield* readPortFile;
          const candidates = [
            ...Option.match(cached, {
              onNone: () => [] as number[],
              onSome: (port) => [port],
            }),
            ...config.ports,
          ].filter((port, index, all) => all.indexOf(port) === index);
          for (const port of candidates) {
            const health = yield* healthAt(port);
            if (Option.isSome(health) && isMine(health.value)) {
              return Option.some({ port, health: health.value });
            }
          }
          return Option.none<FoundDaemon>();
        },
      );

      // Self-spawn `intervu server` detached, redirecting its output to the log
      // file. `unref` lets this CLI exit without waiting on the daemon.
      const spawnDaemon = Effect.gen(function* () {
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* Effect.sync(() => {
          const fd = openSync(config.logFile, "a");
          const child = Bun.spawn(
            [process.execPath, process.argv[1] ?? "", "server"],
            {
              env: process.env,
              stdin: "ignore",
              stdout: fd,
              stderr: fd,
            },
          );
          child.unref();
        });
      });

      // Scan until the freshly spawned daemon binds somewhere in my ports
      // and answers as mine, capped at ~5s. The daemon picks its own port
      // (the first free one in the range, or the pinned one).
      const waitMine: Effect.Effect<FoundDaemon, ServerStartTimeout> =
        findMine.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: Option.isSome,
          }),
          Effect.timeout("5 seconds"),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ServerStartTimeout({ port: config.port })),
              onSome: (found) => Effect.succeed(found),
            }),
          ),
          Effect.catchTag(
            "TimeoutError",
            () => new ServerStartTimeout({ port: config.port }),
          ),
        );

      // Read the shared `server.pid` and SIGTERM the daemon, the one channel
      // that works across the version gap (ADR 0015): every version writes the
      // pidfile and dies gracefully on the signal. Returns the signalled pid, or
      // `None` when there is nothing to stop - the pidfile is absent, holds a
      // non-numeric pid, or names a process that is already gone (`process.kill`
      // throws, treated as the benign no-op). Shared by `intervu stop` and
      // takeover; a genuine pidfile read error still propagates.
      const signalStop: Effect.Effect<
        Option.Option<number>,
        PlatformError.PlatformError
      > = Effect.gen(function* () {
        const exists = yield* fs.exists(config.pidFile);
        if (!exists) {
          return Option.none();
        }
        const pidText = yield* fs.readFileString(config.pidFile);
        const pid = Number.parseInt(pidText.trim(), 10);
        if (Number.isNaN(pid)) {
          return Option.none();
        }
        const signalled = yield* Effect.try(() =>
          process.kill(pid, "SIGTERM"),
        ).pipe(Effect.orElseSucceed(() => false));
        return signalled ? Option.some(pid) : Option.none();
      });

      // After SIGTERM, wait for the stale daemon to release its port, capped
      // at ~5s. If it will not exit in that window the takeover cannot proceed.
      const waitPortFree = (port: number) =>
        healthAt(port).pipe(
          Effect.map(Option.isNone),
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (free) => free,
          }),
          Effect.timeout("5 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new StaleServerTakeover({
                port,
                reason:
                  "the stale daemon did not exit within the takeover window",
              }),
            ),
          ),
        );

      // Evict a strictly-older daemon of mine and spawn our own (ADR 0015):
      // signal via the state dir's pidfile - mine by construction - wait for
      // its port to free, then spawn and wait for the new daemon. A missing or
      // garbage pidfile (nothing to signal) means the old daemon is orphaned
      // on the port and the client refuses to spawn into it.
      const takeover = (port: number) =>
        Effect.gen(function* () {
          const signalled = yield* signalStop;
          if (Option.isNone(signalled)) {
            return yield* Effect.fail(
              new StaleServerTakeover({
                port,
                reason:
                  "a stale daemon holds the port but its pidfile is missing or invalid",
              }),
            );
          }
          yield* waitPortFree(port);
          yield* spawnDaemon;
          return yield* waitMine;
        });

      /** Remember where my daemon answered, for this run and the next one. */
      const adopt = (found: FoundDaemon) =>
        Effect.gen(function* () {
          yield* Ref.set(resolvedPort, found.port);
          if (!config.portPinned) {
            yield* writePortFile(found.port);
          }
          return found.health;
        });

      // The `open` path (ADR 0015, extended for the port range): find my
      // daemon (same state dir; a foreign daemon on a port is left alone),
      // spawn one when none answers - the daemon binds the first free range
      // port itself - and take over a strictly-older daemon of mine. A
      // freshly spawned daemon is our own version, so it is never stale.
      const ensure = findMine.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => spawnDaemon.pipe(Effect.flatMap(() => waitMine)),
            onSome: (found) => Effect.succeed(found),
          }),
        ),
        Effect.flatMap((found) =>
          isStaleVersion(found.health.version, config.version)
            ? takeover(found.port)
            : Effect.succeed(found),
        ),
        Effect.flatMap(adopt),
      );

      // The poll/end path: a healthy daemon of mine must already exist -
      // these never spawn one (ADR 0009), so none found is a definitive
      // `DaemonNotRunning`. The same version predicate runs, but a
      // strictly-older daemon is a refuse-and-redirect `StaleDaemon` (re-run
      // `intervu <file>` to take over) rather than an inline takeover on the
      // long-poll hot path.
      const requireHealthy = findMine.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new DaemonNotRunning()),
            onSome: (found) => Effect.succeed(found),
          }),
        ),
        Effect.flatMap((found) =>
          isStaleVersion(found.health.version, config.version)
            ? Effect.fail(new StaleDaemon())
            : adopt(found),
        ),
      );

      const openSession = (path: string, kind: SessionKind) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(
            `${yield* baseUrl}/sessions`,
          ).pipe(HttpClientRequest.bodyJsonUnsafe({ path, kind }));
          const response = yield* client.execute(request);
          return yield* HttpClientResponse.schemaBodyJson(Session)(response);
        });

      // One poll request, held open until the daemon settles it. A `404`
      // means nothing is open at this path - a structured `ReviewNotOpen`,
      // not feedback. No client-side response timeout, so an indefinite
      // block is not severed by this side.
      const pollOnce = (
        path: string,
        timeoutSeconds: Option.Option<number>,
        agentReply: Option.Option<string>,
      ) =>
        Effect.gen(function* () {
          const withTimeout = Option.match(timeoutSeconds, {
            onNone: () => ({ path }),
            onSome: (seconds) => ({ path, timeoutSeconds: seconds }),
          });
          const body = Option.match(agentReply, {
            onNone: () => withTimeout,
            onSome: (reply) => ({ ...withTimeout, agentReply: reply }),
          });
          const request = HttpClientRequest.post(`${yield* baseUrl}/poll`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          );
          const response = yield* client.execute(request);
          if (response.status === 404) {
            return yield* new ReviewNotOpen({ path });
          }
          return yield* HttpClientResponse.schemaBodyJson(PollResponse)(
            response,
          );
        });

      /** A connection that died without a decoded response - not an answer. */
      const isTransportDrop = (
        error: PollError,
      ): error is HttpClientError.HttpClientError =>
        HttpClientError.isHttpClientError(error) &&
        error.reason._tag === "TransportError";

      // Long-poll with client-side reconnect: the poll response is a single
      // TOON document, so the wire cannot carry keepalives - a proxy that
      // cuts idle connections kills the request instead. A transport drop
      // without a decoded response re-issues the same poll silently,
      // preserving any remaining `--timeout` budget; only a daemon that
      // stops answering `/health` turns the drop into a structured
      // `DaemonNotRunning`. The agent-reply rides only the first request,
      // since the daemon posted it before the wait began.
      const poll = (
        path: string,
        timeoutSeconds: Option.Option<number>,
        agentReply: Option.Option<string>,
      ) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          let reply = agentReply;
          while (true) {
            const now = yield* Clock.currentTimeMillis;
            const remaining = Option.map(timeoutSeconds, (total) =>
              Math.ceil(total - (now - startedAt) / 1000),
            );
            if (Option.isSome(remaining) && remaining.value <= 0) {
              return new PollResponse({
                timedOut: true,
                ended: false,
                feedback: [],
              });
            }
            const attempt = yield* pollOnce(path, remaining, reply).pipe(
              Effect.map(Option.some),
              Effect.catch((error) =>
                isTransportDrop(error)
                  ? Effect.succeed(Option.none<PollResponse>())
                  : Effect.fail(error),
              ),
            );
            if (Option.isSome(attempt)) {
              return attempt.value;
            }
            reply = Option.none();
            const alive = yield* Ref.get(resolvedPort).pipe(
              Effect.flatMap(healthAt),
            );
            if (Option.isNone(alive)) {
              return yield* Effect.fail(new DaemonNotRunning());
            }
            // A short breath between re-issues, so a path that drops
            // instantly (while /health still answers) cannot spin hot.
            yield* Effect.sleep("250 millis");
          }
        });

      // End from the terminal (ADR 0011): the agent-facing thin client over
      // `POST /end`. Path-addressed and lookup-without-create, so a `404` is a
      // structured `ReviewNotOpen` - the daemon is up but nothing is open here.
      const end = (path: string) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(`${yield* baseUrl}/end`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ path }),
          );
          const response = yield* client.execute(request);
          if (response.status === 404) {
            return yield* new ReviewNotOpen({ path });
          }
          return yield* HttpClientResponse.schemaBodyJson(EndResponse)(
            response,
          );
        });

      // Post an Agent-reply without waiting (ADR 0020). Path-addressed and
      // lookup-without-create, so a `404` is a structured `ReviewNotOpen`.
      const reply = (path: string, message: string) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(
            `${yield* baseUrl}/reply`,
          ).pipe(HttpClientRequest.bodyJsonUnsafe({ path, message }));
          const response = yield* client.execute(request);
          if (response.status === 404) {
            return yield* new ReviewNotOpen({ path });
          }
          return yield* HttpClientResponse.schemaBodyJson(ReplyResponse)(
            response,
          );
        });

      // The live diagnostics read (`intervu status`): a healthy, current
      // daemon must already exist - `requireHealthy` turns a refused
      // connection into `DaemonNotRunning` and a strictly-older daemon
      // (which has no `/status` route) into `StaleDaemon` before the read.
      const status = requireHealthy.pipe(
        Effect.flatMap(() => baseUrl),
        Effect.flatMap((url) =>
          client.execute(HttpClientRequest.get(`${url}/status`)),
        ),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(StatusResponse)),
      );

      return {
        ensure,
        requireHealthy,
        signalStop,
        openSession,
        poll,
        reply,
        end,
        status,
      };
    }),
  );
}
