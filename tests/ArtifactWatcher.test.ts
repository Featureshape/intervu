import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, PubSub } from "effect";
import { ArtifactWatcher } from "../src/ArtifactWatcher.ts";
import { SessionKey } from "../src/Session.ts";
import {
  ArtifactReloaded,
  FeedbackQueued,
  SessionHub,
} from "../src/SessionHub.ts";

/**
 * `ArtifactWatcher` (ADR 0010, 0020): the per-key watcher starts on the first SSE
 * connection's `track` and stops on the last release, and it publishes only when
 * the one artifact path changes. The real Bun filesystem is provided so the stats
 * run against real files.
 */

const testLayer = ArtifactWatcher.layer.pipe(
  Layer.provideMerge(SessionHub.layer),
  Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);

describe("ArtifactWatcher", () => {
  it.effect("starts on the first track and stops on the last release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const watcher = yield* ArtifactWatcher;

      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "artifact.html");
      yield* fs.writeFileString(file, "<html></html>");
      const key = SessionKey.make("watch-refcount");

      expect(yield* watcher.watching(key)).toBe(false);

      yield* Effect.scoped(
        Effect.gen(function* () {
          // First connection: the watcher starts.
          yield* watcher.track(key, file);
          expect(yield* watcher.watching(key)).toBe(true);

          // Second connection rides the same watcher.
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* watcher.track(key, file);
              expect(yield* watcher.watching(key)).toBe(true);
            }),
          );

          // One released, one still open: the watcher keeps running.
          expect(yield* watcher.watching(key)).toBe(true);
        }),
      );

      // The last connection closed: the watcher stops.
      expect(yield* watcher.watching(key)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  /**
   * Publishes through the real tick and debounce, so these run on the live clock.
   * `settle` is comfortably longer than one tick plus the debounce.
   */
  const settle = "600 millis";

  const reloadsDuring = (key: SessionKey, act: Effect.Effect<void, unknown>) =>
    Effect.gen(function* () {
      const hub = yield* SessionHub;
      const subscription = yield* hub.subscribe(key);
      yield* Effect.sleep(settle);
      yield* act;
      yield* Effect.sleep(settle);
      // `takeAll` waits for at least one event, so publish one that is never kept.
      yield* hub.publish(key, new FeedbackQueued());
      const events = yield* PubSub.takeAll(subscription);
      return Array.from(events).filter(
        (event) => event._tag === "ArtifactReloaded",
      );
    });

  it.live("publishes the new version when the artifact is edited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const watcher = yield* ArtifactWatcher;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "artifact.html");
        yield* fs.writeFileString(file, "one");
        const key = SessionKey.make("watch-edit");
        yield* watcher.track(key, file);

        const reloads = yield* reloadsDuring(
          key,
          fs.writeFileString(file, "two, longer"),
        );

        const current = yield* watcher.version(file);
        expect(reloads).toStrictEqual([
          new ArtifactReloaded({ version: Option.getOrThrow(current) }),
        ]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.live("detects an atomic rename-replace of the artifact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const watcher = yield* ArtifactWatcher;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "artifact.html");
        const temp = path.join(dir, "artifact.html.tmp");
        yield* fs.writeFileString(file, "one");
        const key = SessionKey.make("watch-rename");
        yield* watcher.track(key, file);

        const reloads = yield* reloadsDuring(
          key,
          fs
            .writeFileString(temp, "replaced")
            .pipe(Effect.flatMap(() => fs.rename(temp, file))),
        );

        expect(reloads).toHaveLength(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.live("ignores other files, including a same-named nested file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const watcher = yield* ArtifactWatcher;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "artifact.html");
        const nested = path.join(dir, "packages", "billing");
        yield* fs.writeFileString(file, "one");
        yield* fs.makeDirectory(nested, { recursive: true });
        const key = SessionKey.make("watch-monorepo");
        yield* watcher.track(key, file);

        const reloads = yield* reloadsDuring(
          key,
          fs
            .writeFileString(path.join(nested, "artifact.html"), "nested")
            .pipe(
              Effect.flatMap(() =>
                fs.writeFileString(path.join(dir, "other.txt"), "other"),
              ),
            ),
        );

        expect(reloads).toHaveLength(0);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports no version for a missing artifact", () =>
    Effect.gen(function* () {
      const watcher = yield* ArtifactWatcher;
      const version = yield* watcher.version("/no/such/artifact.html");
      expect(Option.isNone(version)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
