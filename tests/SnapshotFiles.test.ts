import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Option, Path } from "effect";
import { AppConfig } from "../src/AppConfig.ts";
import { SnapshotFiles } from "../src/SnapshotFiles.ts";

/**
 * `SnapshotFiles` against the real filesystem (ADR 0021): where a snapshot lands,
 * that identical snapshots share a file, that files are owner-only and pruned, and
 * that a failure asks for inline delivery instead of losing the Feedback.
 */

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const withStateDir = (stateDir: string) =>
  SnapshotFiles.layer.pipe(
    Layer.provide(platform),
    Layer.provide(
      Layer.succeed(AppConfig, {
        version: "0.0.0",
        hostname: "127.0.0.1",
        port: 1,
        idleTimeout: Duration.seconds(30),
        stateDir,
        stateFile: `${stateDir}/state.json`,
        pidFile: `${stateDir}/server.pid`,
        logFile: `${stateDir}/server.log`,
        homeDir: Option.some("/home/tester"),
        currentDir: "/project",
        browser: Option.none(),
      }),
    ),
  );

const saveIn = (stateDir: string, artifact: string, html: string) =>
  Effect.gen(function* () {
    const snapshots = yield* SnapshotFiles;
    return yield* snapshots.save(artifact, html);
  }).pipe(Effect.provide(withStateDir(stateDir)));

describe("SnapshotFiles", () => {
  it.effect("writes the snapshot to a file under the state directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();

        const saved = yield* saveIn(
          stateDir,
          "/a/report.html",
          "<html>1</html>",
        );

        const file = Option.getOrThrow(saved);
        expect(file.startsWith(`${stateDir}/snapshots/`)).toBe(true);
        expect(file.endsWith(".html")).toBe(true);
        expect(yield* fs.readFileString(file)).toBe("<html>1</html>");
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect("shares one file between identical snapshots of an artifact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();

        const first = yield* saveIn(
          stateDir,
          "/a/report.html",
          "<html>1</html>",
        );
        const again = yield* saveIn(
          stateDir,
          "/a/report.html",
          "<html>1</html>",
        );
        const changed = yield* saveIn(
          stateDir,
          "/a/report.html",
          "<html>2</html>",
        );
        const other = yield* saveIn(
          stateDir,
          "/b/report.html",
          "<html>1</html>",
        );

        expect(again).toStrictEqual(first);
        expect(changed).not.toStrictEqual(first);
        expect(other).not.toStrictEqual(first);
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect("makes the snapshot readable by its owner only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped();

        const saved = yield* saveIn(
          stateDir,
          "/a/report.html",
          "<html>1</html>",
        );

        const file = Option.getOrThrow(saved);
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.live("keeps only the newest 20 snapshots of an artifact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped();

        const saved = yield* Effect.forEach(
          Array.from({ length: 23 }, (_, n) => n),
          (n) =>
            saveIn(stateDir, "/a/report.html", `<html>${n}</html>`).pipe(
              Effect.delay("5 millis"),
            ),
        );

        const newest = Option.getOrThrow(saved[22] ?? Option.none());
        const oldest = Option.getOrThrow(saved[0] ?? Option.none());
        expect(yield* fs.readDirectory(path.dirname(newest))).toHaveLength(20);
        expect(yield* fs.exists(newest)).toBe(true);
        expect(yield* fs.exists(oldest)).toBe(false);
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect("asks for inline delivery when the snapshot cannot be saved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        // A file where the state directory should be makes every write fail.
        const notADirectory = path.join(dir, "state");
        yield* fs.writeFileString(notADirectory, "in the way");

        const saved = yield* saveIn(
          notADirectory,
          "/a/report.html",
          "<html>1</html>",
        );

        expect(Option.isNone(saved)).toBe(true);
      }),
    ).pipe(Effect.provide(platform)),
  );
});
