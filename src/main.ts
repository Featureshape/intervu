import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Cause,
  Clock,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { AppConfig, version } from "./AppConfig.ts";
import * as AppProbe from "./AppProbe.ts";
import * as AppUrl from "./AppUrl.ts";
import { ArtifactWatcher } from "./ArtifactWatcher.ts";
import * as Browser from "./Browser.ts";
import { BrowserAssets } from "./BrowserAssets.ts";
import { CommandResolver } from "./CommandResolver.ts";
import * as ErrorReport from "./ErrorReport.ts";
import { ArtifactNotFound, ConflictingSetupScope } from "./Errors.ts";
import * as IdleShutdown from "./IdleShutdown.ts";
import * as Output from "./Output.ts";
import { PluginRegistry } from "./PluginRegistry.ts";
import type { StatusResponse } from "./Protocol.ts";
import * as Server from "./Server.ts";
import { ServerLifecycle } from "./ServerLifecycle.ts";
import type { SessionKind } from "./Session.ts";
import { SessionHub } from "./SessionHub.ts";
import { SessionPersistence } from "./SessionPersistence.ts";
import { SessionStore } from "./SessionStore.ts";
import { Setup } from "./Setup.ts";
import { SkillAsset } from "./SkillAsset.ts";
import { SnapshotFiles } from "./SnapshotFiles.ts";
import * as Toon from "./Toon.ts";
import { WaitingOrigins, waitingElsewhere } from "./WaitingOrigins.ts";

const bin = "intervu";
const description =
  "Local AXI-style CLI for collaborative review of agent-generated HTML artifacts.";

/**
 * The single emit boundary: every byte intervu writes to stdout passes through
 * here. Success output and the structured-error envelope (ADR 0014) both land
 * here, so stdout has exactly one writer.
 */
const emit = (text: string): Effect.Effect<void> => Console.log(text);

/**
 * Bare `intervu`: the content-first home view (ADR 0013). Reads the `open`
 * Sessions straight from the persisted state file - no daemon, zero network
 * calls - and prints each as `{key, path, status}`. `ended` Sessions are
 * history and omitted; an empty list prints an explicit empty-state help line,
 * distinct from any error.
 */
const root = Command.make(bin, {}, () =>
  Effect.gen(function* () {
    const persistence = yield* SessionPersistence;
    const live = (yield* persistence.load).filter(
      (session) => session.status === "open",
    );

    const view = Output.home({
      bin,
      description,
      sessions: live.map((session) => ({
        key: session.key,
        path: session.path,
        status: session.status,
      })),
      help:
        live.length === 0
          ? "no active reviews - run 'intervu <file|url>' to open one"
          : "run 'intervu poll <file|url>' to receive feedback, or 'intervu <file|url>' to open another",
    });
    yield* emit(yield* Toon.encode(view));
  }),
);

/**
 * The Session a command names: an absolute `http(s)` URL selects URL mode (ADR
 * 0022), anything else is the artifact file it always was. The URL is tried
 * first, so a file path never reaches the URL parser's error.
 */
const sessionTarget = (description: string) =>
  Argument.string("file|url").pipe(
    Argument.filterMap(
      AppUrl.parseAppUrl,
      (raw) => `${raw} is not an http(s) URL`,
    ),
    Argument.orElseResult(() => Argument.file("file")),
    Argument.withDescription(description),
  );

/** How `poll`, `reply` and `end` describe the Session they act on. */
const reviewedTarget = "the artifact under review, or the reviewed app's URL";

/** An artifact's realpath, the handle its Session is keyed by (ADR 0001). */
const artifactRealPath = Effect.fn("artifactRealPath")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .realPath(file)
    .pipe(Effect.mapError(() => new ArtifactNotFound({ path: file })));
});

/**
 * The Session `poll`, `reply` and `end` act on. `handle` is what the daemon
 * finds it by: a URL's origin, so any route of the app names its Session (ADR
 * 0022), or a file's realpath. `name` is how help lines spell the next command:
 * the origin, or the file as typed. `kind` picks the help lines' wording.
 */
const resolveTarget = Effect.fn("resolveTarget")(function* (
  target: Result.Result<AppUrl.AppUrl, string>,
) {
  if (Result.isSuccess(target)) {
    const origin = target.success.origin;
    const kind: SessionKind = "app";
    return { handle: origin, name: origin, kind };
  }
  const file = target.failure;
  const kind: SessionKind = "artifact";
  return { handle: yield* artifactRealPath(file), name: file, kind };
});

/**
 * `intervu open <file>` (and the bare-file alias): resolve the artifact's
 * realpath, ensure the daemon is up, open or resume the Session, pop a browser
 * tab at `/s/:key`, and print the Session as TOON.
 */
const openArtifact = Effect.fn("openArtifact")(function* (file: string) {
  const config = yield* AppConfig;
  const lifecycle = yield* ServerLifecycle;

  const realPath = yield* artifactRealPath(file);

  yield* lifecycle.ensure;
  const session = yield* lifecycle.openSession(realPath, "artifact");

  const url = `http://${config.hostname}:${config.port}/s/${session.key}`;
  yield* Browser.openTab(url, config.browser);

  const view = Output.session({
    key: session.key,
    path: session.path,
    status: session.status,
    help: `review open - run 'intervu poll ${file}' to receive feedback`,
  });
  yield* emit(yield* Toon.encode(view));
});

/**
 * The help line of `intervu <url>`, from what the plugin's relay answered at
 * `origin`: the next step when it sees the Session, else what to fix first.
 */
const pluginHelp = (
  plugin: AppProbe.PluginAnswer,
  origin: string,
  next: string,
): string => {
  switch (plugin) {
    case "sees-session":
      return `review open - ${next}`;
    case "refused":
      return `review open, but the intervu Vite plugin at ${origin} refused the request as not from the dev server's own origin - the dev server's log names the header it rejected (behind a proxy, forward the browser's Host or X-Forwarded-Host and add the hostname to server.allowedHosts), then ${next}`;
    case "other-session":
      return `review open, but the intervu Vite plugin at ${origin} does not see it - the dev server reaches a different intervu daemon, or none; start the dev server with the same INTERVU_PORT as this shell, then ${next}`;
    case "missing":
      return `review open, but the intervu Vite plugin is missing at ${origin} - add \`import { intervu } from "intervu/vite"\` and \`intervu()\` to the plugins in vite.config.ts and restart the dev server, then ${next}`;
  }
};

/** How fresh a plugin-report must be to outrank a failed probe. */
const freshReportMs = 90_000;

/**
 * The plugin sighting that covers `origin`, when the daemon holds a fresh
 * one: a plugin whose own origin is `origin`, or one that has seen a page on
 * `origin` succeed. A probe the sandbox or a proxy blocks says `missing` or
 * `refused`; a fresh sighting proves the plugin is alive and reporting, so
 * the help line must not claim it is missing.
 */
const sightingCovering = (
  plugins: readonly {
    readonly origin: string;
    readonly seenOrigins: readonly string[];
    readonly lastSeenAt: number;
  }[],
  origin: string,
  now: number,
) =>
  plugins.find(
    (plugin) =>
      now - plugin.lastSeenAt <= freshReportMs &&
      (plugin.origin === origin || plugin.seenOrigins.includes(origin)),
  );

/**
 * The help line when the probe failed but the daemon holds a fresh
 * plugin-report covering `origin`: say what the plugin reported instead of
 * the false "plugin missing" warning.
 */
const reportedPluginHelp = (
  sighting: { readonly origin: string },
  origin: string,
  next: string,
): string =>
  `review open - the probe could not reach ${origin} from here, but its intervu Vite plugin (dev server ${sighting.origin}) is reporting to the daemon for this origin, so the overlay in the browser's tab can find the Session; ${next}`;

/**
 * `intervu open <url>` (and the bare-URL alias): URL mode (ADR 0022). Fail fast
 * with `AppUnreachable` when nothing answers at the URL; otherwise ensure the
 * daemon is up and open or resume the Session for the URL's origin, so every
 * route of one dev server lands in the same Session. A missing `intervu/vite`
 * plugin does not block the Session; the help line says how to add it. The
 * human already has the app open, so no tab opens unless `--open` asks for one,
 * at the URL as given.
 */
const openApp = Effect.fn("openApp")(function* (
  app: AppUrl.AppUrl,
  openTab: boolean,
) {
  const config = yield* AppConfig;
  const lifecycle = yield* ServerLifecycle;

  yield* AppProbe.requireAnswer(app);
  yield* lifecycle.ensure;
  const session = yield* lifecycle.openSession(app.origin, "app");
  // Asked once the daemon is up: the plugin's relay forwards to it.
  const plugin = yield* AppProbe.pluginAnswers(app, session.key);

  if (openTab) {
    yield* Browser.openTab(app.url, config.browser);
  }

  // One best-effort status read serves both enrichments below: a daemon that
  // cannot answer it just leaves the probe's own answer standing.
  const daemonStatus = yield* lifecycle.status.pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<StatusResponse>()),
  );
  const now = yield* Clock.currentTimeMillis;

  // A probe a sandbox or proxy blocks reads `missing` or `refused` even while
  // the plugin is alive; a fresh plugin-report held by the daemon outranks it.
  const sighting =
    plugin === "missing" || plugin === "refused"
      ? Option.flatMap(daemonStatus, (daemon) =>
          Option.fromNullishOr(
            sightingCovering(daemon.plugins, app.origin, now),
          ),
        )
      : Option.none<{ readonly origin: string }>();

  // A browser polling some other origin for a Session that is not there,
  // while this open names none of them, is usually the agent opening the
  // wrong origin - say so (behaviour: waiting origins, did-you-mean).
  const didYouMean = Option.flatMap(daemonStatus, (daemon) =>
    Option.fromNullishOr(
      waitingElsewhere(daemon.waitingOrigins ?? [], app.origin, now),
    ),
  ).pipe(
    Option.map(
      (waitingOrigin) =>
        `a browser at ${waitingOrigin} is looking for a session - did you mean 'intervu ${waitingOrigin}'?`,
    ),
  );

  const next = `run 'intervu poll ${session.path}' to receive feedback`;
  const view = Output.appSession({
    key: session.key,
    origin: session.path,
    status: session.status,
    warning: Option.getOrUndefined(AppUrl.schemePortWarning(app)),
    didYouMean: Option.getOrUndefined(didYouMean),
    help: Option.match(sighting, {
      onNone: () => pluginHelp(plugin, session.path, next),
      onSome: (covered) => reportedPluginHelp(covered, session.path, next),
    }),
  });
  yield* emit(yield* Toon.encode(view));
});

const open = Command.make(
  "open",
  {
    target: sessionTarget(
      "the HTML artifact to review, or a running app's URL such as http://localhost:5173",
    ),
    open: Flag.boolean("open").pipe(
      Flag.withDescription(
        "also open a browser tab at the URL (a file always opens one)",
      ),
    ),
  },
  ({ target, open }) =>
    Effect.gen(function* () {
      if (Result.isSuccess(target)) {
        return yield* openApp(target.success, open);
      }
      return yield* openArtifact(target.failure);
    }),
);

/**
 * `intervu poll <file|url>` (ADR 0009): the agent's long-poll. Resolve the
 * Session's handle (the artifact's realpath, or the app's origin), require an
 * already-running daemon (no spawn), then hold a single request open until the
 * human sends - printing the drained Feedback as TOON. `--timeout <seconds>`
 * bounds the wait and prints `timedOut: true` instead. `--agent-reply
 * "<message>"` posts that message into the human's conversation panel before
 * waiting again (ADR 0010), so the agent can explain what it changed and keep
 * listening. Killing and re-running is safe: queued Feedback survives.
 */
const poll = Command.make(
  "poll",
  {
    target: sessionTarget(reviewedTarget),
    timeout: Flag.optional(Flag.integer("timeout")).pipe(
      Flag.withDescription(
        "seconds to wait before returning timedOut (default: wait indefinitely)",
      ),
    ),
    agentReply: Flag.optional(Flag.string("agent-reply")).pipe(
      Flag.withDescription(
        "post this message into the conversation panel before waiting again",
      ),
    ),
  },
  ({ target, timeout, agentReply }) =>
    Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycle;
      const { handle, name, kind } = yield* resolveTarget(target);

      yield* lifecycle.requireHealthy;
      const response = yield* lifecycle.poll(handle, timeout, agentReply);
      const snapshots = yield* SnapshotFiles;
      const delivered = yield* Effect.forEach(response.feedback, (feedback) =>
        snapshots
          .save(handle, feedback.domSnapshot)
          .pipe(Effect.map((snapshotPath) => ({ feedback, snapshotPath }))),
      );

      const edit =
        kind === "app" ? "edit the app's source" : "edit the artifact";
      const view = response.timedOut
        ? Output.pollTimedOut({
            help: `no feedback within the timeout - run 'intervu poll ${name}' to keep listening`,
          })
        : response.ended
          ? Output.pollEnded({
              feedback: delivered,
              help: `review ended - apply any final feedback above, then stop; re-run 'intervu ${name}' to reopen`,
            })
          : Output.pollFeedback({
              feedback: delivered,
              help: `feedback received - ${edit} or answer with 'intervu reply ${name} "<message>"', then 'intervu poll ${name}' to listen again`,
            });
      yield* emit(yield* Toon.encode(view));
    }),
);

/**
 * `intervu reply <file|url> <message>`: post an Agent-reply into the human's
 * conversation panel and return immediately (ADR 0020). Unlike `poll
 * --agent-reply` it never waits, so the agent can acknowledge feedback before a
 * long edit, or answer a question about the codebase, while a poll stays open.
 */
const reply = Command.make(
  "reply",
  {
    target: sessionTarget(reviewedTarget),
    message: Argument.string("message"),
  },
  ({ target, message }) =>
    Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycle;
      const { handle, name } = yield* resolveTarget(target);

      yield* lifecycle.requireHealthy;
      const response = yield* lifecycle.reply(handle, message);

      const view = Output.replied({
        posted: response.posted,
        help: response.posted
          ? `reply posted - keep a poll open with 'intervu poll ${name}'`
          : response.ended
            ? `nothing posted, the review has ended - re-run 'intervu ${name}' to reopen`
            : "nothing posted, the message was blank",
      });
      yield* emit(yield* Toon.encode(view));
    }),
);

/**
 * `intervu end <file|url>` (ADR 0011): the agent-facing end. Resolve the
 * Session's handle, require an already-running daemon (no spawn, mirroring
 * `poll`), then end the Session over `POST /end` and print the confirmation as
 * TOON. No final-feedback rider - that is the chrome's Send & end. Re-running
 * `intervu <file|url>` resurrects the Session to a live review (ADR 0012).
 */
const end = Command.make(
  "end",
  {
    target: sessionTarget(reviewedTarget),
  },
  ({ target }) =>
    Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycle;
      const { handle, name } = yield* resolveTarget(target);

      yield* lifecycle.requireHealthy;
      yield* lifecycle.end(handle);

      const view = Output.ended({
        help: `review ended - re-run 'intervu ${name}' to reopen`,
      });
      yield* emit(yield* Toon.encode(view));
    }),
);

/**
 * `intervu server`: the foreground daemon. Binds the loopback port, writes the
 * pidfile, serves the routes, and stops gracefully on SIGTERM - `runMain` turns
 * the signal into fiber interruption that runs the pidfile-cleanup finalizer.
 *
 * `--port <n>` binds *this* process to that port (flag > `INTERVU_PORT` >
 * default); it is the foreground/debug form, so clients still resolve the port
 * via env/default and must set `INTERVU_PORT=<n>` to reach a hand-run instance.
 *
 * Idle self-shutdown (ADR 0016): the served layer is raced against an
 * `IdleShutdown` watcher over the shared `SessionHub` live-connection gauge. The
 * watcher winning interrupts `Layer.launch`, which releases the server scope and
 * runs the same pidfile-cleanup finalizer as a SIGTERM, so a respawned-but-
 * unwatched or cleanly-ended daemon never dangles.
 */
const server = Command.make(
  "server",
  {
    port: Flag.optional(Flag.integer("port")).pipe(
      Flag.withDescription(
        "bind the daemon to this port (default: INTERVU_PORT, else 51789)",
      ),
    ),
  },
  ({ port }) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;
      const hub = yield* SessionHub;
      const boundPort = Option.getOrElse(port, () => config.port);

      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(config.pidFile, `${process.pid}`);

      const serverLayer = Server.layer.pipe(
        Layer.provide(BrowserAssets.layer),
        Layer.provide(
          BunHttpServer.layer({
            hostname: config.hostname,
            port: boundPort,
            // Bun closes a connection after 10s without bytes by default, which
            // would sever the SSE stream between its 20s pings (ADR 0020). The
            // daemon is loopback-only, so a dead client still delivers FIN/RST.
            idleTimeout: 0,
          }),
        ),
      );

      yield* Effect.ensuring(
        Effect.race(
          Layer.launch(serverLayer),
          IdleShutdown.watch(hub.connectionChanges, config.idleTimeout),
        ),
        fs
          .remove(config.pidFile, { force: true })
          .pipe(
            Effect.catch((error) =>
              Effect.logError("failed to remove pidfile", error),
            ),
          ),
      );
    }),
);

/**
 * `intervu status`: the live diagnostics read. Unlike the offline Home view
 * (ADR 0013), this one talks to the daemon: it prints the daemon's version,
 * port and state dir, every Session with its Presence, every plugin that has
 * reported in, and their refusal tallies - so the agent can see what the
 * browser side sees without a human relaying the tab. No daemon on the port
 * is an answer, not an error: `daemon: none` with the port it tried.
 */
const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const lifecycle = yield* ServerLifecycle;

    const daemon = yield* lifecycle.status.pipe(
      Effect.map(Option.some),
      Effect.catchTag("DaemonNotRunning", () =>
        Effect.succeed(Option.none<StatusResponse>()),
      ),
    );

    const view = Option.match(daemon, {
      onNone: () =>
        Toon.encode(
          Output.statusNoDaemon({
            port: config.port,
            help: `no daemon is listening on port ${config.port} - run 'intervu <file|url>' to start one`,
          }),
        ),
      onSome: (answer) =>
        Toon.encode(
          Output.status({
            version: answer.version,
            port: answer.port,
            stateDir: answer.stateDir,
            sessions: answer.sessions,
            plugins: answer.plugins,
            waitingOrigins: answer.waitingOrigins ?? [],
            help:
              answer.plugins.length === 0
                ? "no plugin has reported in - a dev server with the intervu/vite plugin reports on start and while tabs are open"
                : "run 'intervu poll <file|url>' on an open Session to receive feedback",
          }),
        ),
    });
    yield* emit(yield* view);
  }),
);

/**
 * `intervu stop`: SIGTERM the daemon via the shared pidfile core
 * (`ServerLifecycle.signalStop`, the same channel takeover uses), which releases
 * the server gracefully. Idempotent (ADR 0014): with no daemon to signal - the
 * pidfile is absent, holds a non-numeric pid, or names a process that is already
 * gone - it is a benign no-op (`stopped: false`, exit 0), so a repeat stop never
 * fails. A genuine read error (e.g. an unreadable pidfile) still propagates.
 */
const stop = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const lifecycle = yield* ServerLifecycle;
    const signalled = yield* lifecycle.signalStop;

    const view = Option.match(signalled, {
      onNone: () => ({
        stopped: false,
        help: "nothing to stop - no daemon is running",
      }),
      onSome: (pid) => ({
        stopped: pid,
        help: "daemon received SIGTERM - it will exit shortly",
      }),
    });
    yield* emit(yield* Toon.encode(view));
  }),
);

/**
 * `intervu setup`: wire intervu into Claude Code. Thin glue over `Setup.install`,
 * which installs both the agent Skill (where Claude Code discovers skills) and a
 * `SessionStart` Hook (merged into the harness settings file so bare `intervu`'s
 * Home view is injected as session-start context, ADR 0013). Each half reports
 * installed-now versus already-present with its resolved location; the result
 * renders as TOON through the single `emit` boundary with a next-step help line.
 * The Skill is carried baked inside the binary (ADR 0007), so this needs no
 * source tree.
 *
 * `--project` scopes both halves to the current project's `.claude` (issue #14)
 * instead of the user-level default, so discovery can be limited to one repo.
 *
 * `--skill-only` / `--hooks-only` restrict setup to exactly one half (issue
 * #15); neither wires both (the default). The two contradict each other, so
 * combining them fails `ConflictingSetupScope` rather than silently dropping a
 * flag. The result reports only the half/halves that were in scope.
 */
const setup = Command.make(
  "setup",
  {
    project: Flag.boolean("project").pipe(
      Flag.withDescription(
        "scope setup to the current project's .claude instead of the user-level default",
      ),
    ),
    skillOnly: Flag.boolean("skill-only").pipe(
      Flag.withDescription("wire only the Skill, leaving the Hook untouched"),
    ),
    hooksOnly: Flag.boolean("hooks-only").pipe(
      Flag.withDescription("wire only the Hook, leaving the Skill untouched"),
    ),
  },
  ({ project, skillOnly, hooksOnly }) =>
    Effect.gen(function* () {
      if (skillOnly && hooksOnly) {
        return yield* Effect.fail(new ConflictingSetupScope({}));
      }
      const scope = skillOnly ? "skill-only" : hooksOnly ? "hook-only" : "both";

      const installer = yield* Setup;
      const result = yield* installer.install({ project, scope });

      const skill = Option.getOrUndefined(result.skill);
      const hook = Option.getOrUndefined(result.hook);
      const changed =
        skill?.action === "installed" || hook?.action === "installed";
      const view = Output.setup({
        skill,
        hook,
        help: changed
          ? "intervu wired up - start a fresh agent session so it discovers the skill and home view, then 'intervu <file>' to open a review"
          : "intervu already wired up - re-running setup changes nothing",
      });
      yield* emit(yield* Toon.encode(view));
    }),
);

const cli = root.pipe(
  Command.withSubcommands([
    open,
    poll,
    reply,
    end,
    server,
    stop,
    status,
    setup,
  ]),
);

/**
 * Bare `intervu <file>` and `intervu <url>` alias `intervu open <file|url>`. The
 * CLI framework can't mix a root positional argument with subcommands, so an
 * unrecognized leading token that isn't a flag is rewritten to `open <arg>`
 * before parsing.
 */
const knownSubcommands = new Set([
  "open",
  "poll",
  "reply",
  "end",
  "server",
  "stop",
  "status",
  "setup",
]);
const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0];
const args =
  firstArg !== undefined &&
  !firstArg.startsWith("-") &&
  !knownSubcommands.has(firstArg)
    ? ["open", ...rawArgs]
    : rawArgs;

const PlatformLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

// `SessionHub` is provided once and re-exported, so the daemon's routes,
// `FeedbackWait`, and the `ArtifactWatcher` all share the one hub instance - a
// second hub would split publishes from subscribers.
const AppLayer = Layer.mergeAll(
  SessionStore.layer,
  ServerLifecycle.layer,
  ArtifactWatcher.layer,
  Setup.layer,
  SnapshotFiles.layer,
  PluginRegistry.layer,
  WaitingOrigins.layer,
).pipe(
  Layer.provideMerge(SessionHub.layer),
  Layer.provideMerge(SessionPersistence.fileLayer),
  Layer.provideMerge(SkillAsset.layer),
  Layer.provideMerge(CommandResolver.layer),
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(PlatformLayer),
);

/**
 * The structured error contract (ADR 0014), wired onto the `emit` seam:
 *
 * - `tapError` classifies every typed failure that reaches here and prints the
 *   TOON envelope on stdout (or no-ops on framework `CliError`, already
 *   rendered). It preserves the original failure, so the run still exits 1.
 * - `tapDefect` leaves bugs (`die`) raw and loud on stderr via the pretty cause;
 *   they are never masked as a clean structured error.
 *
 * `disableErrorReporting: true` suppresses only the runtime's automatic failure
 * log, so neither tier is double-printed; `defaultTeardown` still computes the
 * exit code (1 on failure, 0 on success).
 */
const program = Command.runWith(cli, { version })(args).pipe(
  Effect.tapError((error) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const view = ErrorReport.report(error, { logFile: config.logFile });
      if (Option.isSome(view)) {
        yield* emit(yield* Toon.encode(view.value));
      }
    }),
  ),
  Effect.tapDefect((defect) => Console.error(Cause.pretty(Cause.die(defect)))),
  Effect.provide(AppLayer),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
