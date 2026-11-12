import * as os from "node:os";
import {
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import * as Context from "effect/Context";
import { version as packageVersion } from "../package.json" with {
  type: "json",
};
import { daemonPortFrom, daemonPortsFrom } from "./DaemonPort.ts";
import { defaultSessionTtlSeconds } from "./SessionTtl.ts";

/**
 * The version reported by `GET /health` and `intervu --version`, read from
 * `package.json` and inlined at build time. It must track releases, because the
 * stale-daemon takeover (ADR 0015) only fires when a client is strictly newer.
 */
export const version = packageVersion;

/** Default idle-shutdown grace in seconds; `INTERVU_IDLE_TIMEOUT` overrides. */
const defaultIdleSeconds = 30;

const IdleSeconds = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
);

/** `INTERVU_SESSION_TTL` in seconds: at least a minute, at most a year. */
const TtlSeconds = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 60, maximum: 31_536_000 })),
);

/**
 * Resolved runtime configuration shared by the CLI client and the daemon: the
 * loopback bind target and the per-user state directory with its derived file
 * paths. State dir resolves `$INTERVU_STATE_DIR` -> `$XDG_STATE_HOME/intervu` ->
 * `~/.local/state/intervu` (ADR 0002), the same shape on macOS and Linux.
 */
export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly version: string;
    readonly hostname: string;
    readonly port: number;
    /**
     * The ports this client and the daemons it spawns live on: exactly the
     * pinned port when `INTERVU_PORT` is set, else the fixed range
     * 51789-51798 that daemons from different sandboxes coexist on.
     */
    readonly ports: readonly number[];
    /** Whether `INTERVU_PORT` pinned a single port (no range scan). */
    readonly portPinned: boolean;
    readonly idleTimeout: Duration.Duration;
    /** How long a Session may idle before it counts as `ended`. */
    readonly sessionTtl: Duration.Duration;
    readonly stateDir: string;
    readonly stateFile: string;
    readonly pidFile: string;
    readonly logFile: string;
    /** Where the client remembers which range port its daemon bound. */
    readonly portFile: string;
    readonly homeDir: Option.Option<string>;
    readonly currentDir: string;
    readonly browser: Option.Option<string>;
  }
>()("@intervu/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const rawPort = yield* Config.option(Config.string("INTERVU_PORT"));
      const port = daemonPortFrom(Option.getOrUndefined(rawPort));
      const ports = daemonPortsFrom(Option.getOrUndefined(rawPort));
      const idleSeconds = yield* Config.schema(
        IdleSeconds,
        "INTERVU_IDLE_TIMEOUT",
      ).pipe(Config.orElse(() => Config.succeed(defaultIdleSeconds)));
      const ttlSeconds = yield* Config.schema(
        TtlSeconds,
        "INTERVU_SESSION_TTL",
      ).pipe(Config.orElse(() => Config.succeed(defaultSessionTtlSeconds)));
      const override = yield* Config.option(Config.string("INTERVU_STATE_DIR"));
      const xdg = yield* Config.option(Config.string("XDG_STATE_HOME"));
      // An unset or empty `HOME` is unresolved: it falls back to "" for the
      // state-dir derivation but stays `None` for `homeDir`, so `setup` can fail
      // `HomeDirectoryUnresolved` rather than installing under a bare root.
      const homeDir = (yield* Config.option(Config.string("HOME"))).pipe(
        Option.filter((value) => value.length > 0),
      );
      const home = Option.getOrElse(homeDir, () => "");
      // The current project root: the cwd's `.claude` is where `setup --project`
      // scopes the Skill and Hook, the way `homeDir` anchors the user-level
      // default. Always resolvable, so a plain string rather than an Option.
      const currentDir = process.cwd();
      // The program that opens a browser tab, run with the URL as its only
      // argument; unset means the OS default browser.
      const browser = (yield* Config.option(
        Config.string("INTERVU_BROWSER"),
      )).pipe(Option.filter((value) => value.length > 0));

      const resolvedStateDir = Option.match(override, {
        onSome: (dir) => dir,
        onNone: () =>
          Option.match(xdg, {
            onSome: (base) => path.join(base, "intervu"),
            onNone: () => path.join(home, ".local", "state", "intervu"),
          }),
      });

      // Inside a sandbox `~/.local/state` is often not writable. Rather than
      // fail every command, fall back to a per-user dir under `$TMPDIR` and
      // say so; the fallback is deterministic, so the CLI and the daemon it
      // spawns with the same environment agree on it, and `intervu status`
      // names the state dir in use.
      const fs = yield* FileSystem.FileSystem;
      const writable = yield* fs
        .makeDirectory(resolvedStateDir, { recursive: true })
        .pipe(
          Effect.andThen(fs.access(resolvedStateDir, { writable: true })),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      const user = (yield* Config.option(Config.string("USER"))).pipe(
        Option.filter((value) => value.length > 0),
        Option.getOrElse(() => "user"),
      );
      const stateDir = writable
        ? resolvedStateDir
        : path.join(os.tmpdir(), `intervu-${user}`);
      if (!writable) {
        // Straight to stderr: stdout is the TOON document and has exactly
        // one writer (ADR 0014).
        yield* Console.error(
          `[intervu] the state dir ${resolvedStateDir} is not writable - using ${stateDir} instead`,
        );
      }

      return {
        version,
        hostname: "127.0.0.1",
        port,
        ports,
        portPinned: ports.length === 1,
        idleTimeout: Duration.seconds(idleSeconds),
        sessionTtl: Duration.seconds(ttlSeconds),
        stateDir,
        stateFile: path.join(stateDir, "state.json"),
        pidFile: path.join(stateDir, "server.pid"),
        logFile: path.join(stateDir, "server.log"),
        portFile: path.join(stateDir, "daemon.port"),
        homeDir,
        currentDir,
        browser,
      };
    }),
  );
}
