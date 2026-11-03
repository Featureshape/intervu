import {
  Effect,
  Fiber,
  FileSystem,
  Filter,
  Layer,
  Option,
  type Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import * as Context from "effect/Context";
import type { SessionKey } from "./Session.ts";
import { ArtifactReloaded, SessionHub } from "./SessionHub.ts";

/**
 * The lazy, ref-counted watcher behind live-reload (ADR 0010, 0020). A watcher
 * for a key runs only while at least one SSE connection for that key is open:
 * `track` is acquired on the SSE stream's scope, starting the watcher on the
 * first connection and stopping it on the last. This ref-count is deliberately
 * separate from the Presence poll counter - a browser connection drives reload,
 * not the agent's listening/working state.
 *
 * The watcher stats the one artifact path on a short tick and publishes
 * `ArtifactReloaded` when its version changes. It deliberately avoids
 * `FileSystem.watch`, which is always recursive: on an artifact inside a large
 * repo that walks and watches the whole subtree, and a same-named file anywhere
 * below it looks like an edit. A stat costs the same at any repo size, cannot
 * exhaust inotify watches, and handles an atomic-save rename-replace. Sibling
 * assets do not trigger a reload this slice.
 */

interface Watcher {
  readonly count: number;
  readonly fiber: Fiber.Fiber<void>;
}

const POLL_INTERVAL = "100 millis";
const DEBOUNCE = "150 millis";

export class ArtifactWatcher extends Context.Service<
  ArtifactWatcher,
  {
    readonly track: (
      key: SessionKey,
      artifactPath: string,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly watching: (key: SessionKey) => Effect.Effect<boolean>;
    /**
     * The artifact's current version (modified time plus size), or `None` while
     * the file is missing, as it briefly can be during a rename-replace.
     */
    readonly version: (
      artifactPath: string,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("@intervu/ArtifactWatcher") {
  static readonly layer = Layer.effect(
    ArtifactWatcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const hub = yield* SessionHub;
      // The daemon-lifetime scope the watcher fibers are forked into, so a fiber
      // outlives the connection that started it (other connections may keep the
      // ref-count up) and is interrupted explicitly on the last release.
      const scope = yield* Effect.scope;
      const watchers = yield* SynchronizedRef.make(
        new Map<SessionKey, Watcher>(),
      );

      const version = (artifactPath: string) =>
        fs.stat(artifactPath).pipe(
          Effect.map((info) => {
            const modified = Option.match(info.mtime, {
              onNone: () => 0,
              onSome: (mtime) => mtime.getTime(),
            });
            return Option.some(`${modified}-${info.size}`);
          }),
          Effect.catch((error) =>
            Effect.logDebug("artifact stat failed", error).pipe(
              Effect.as(Option.none<string>()),
            ),
          ),
        );

      // The first version seen is the baseline, not an edit, hence `drop(1)`. An
      // edit that lands before the baseline is covered by the version the SSE
      // route sends on connect.
      const watcherFor = (key: SessionKey, artifactPath: string) =>
        Stream.tick(POLL_INTERVAL).pipe(
          Stream.mapEffect(() => version(artifactPath)),
          Stream.filterMap(Filter.fromPredicateOption((v) => v)),
          Stream.changes,
          Stream.drop(1),
          Stream.debounce(DEBOUNCE),
          Stream.runForEach((current) =>
            hub.publish(key, new ArtifactReloaded({ version: current })),
          ),
        );

      const track = (key: SessionKey, artifactPath: string) =>
        SynchronizedRef.modifyEffect(watchers, (map) =>
          Effect.gen(function* () {
            const existing = map.get(key);
            if (existing !== undefined) {
              const next = new Map(map);
              next.set(key, { ...existing, count: existing.count + 1 });
              return [undefined, next] as const;
            }
            const fiber = yield* watcherFor(key, artifactPath).pipe(
              Effect.forkIn(scope),
            );
            const next = new Map(map);
            next.set(key, { count: 1, fiber });
            return [undefined, next] as const;
          }),
        ).pipe(Effect.flatMap(() => Effect.addFinalizer(() => release(key))));

      const release = (key: SessionKey) =>
        SynchronizedRef.modifyEffect(watchers, (map) =>
          Effect.gen(function* () {
            const existing = map.get(key);
            if (existing === undefined) {
              return [undefined, map] as const;
            }
            if (existing.count > 1) {
              const next = new Map(map);
              next.set(key, { ...existing, count: existing.count - 1 });
              return [undefined, next] as const;
            }
            yield* Fiber.interrupt(existing.fiber);
            const next = new Map(map);
            next.delete(key);
            return [undefined, next] as const;
          }),
        );

      const watching = (key: SessionKey): Effect.Effect<boolean> =>
        SynchronizedRef.get(watchers).pipe(Effect.map((map) => map.has(key)));

      return { track, watching, version };
    }),
  );
}
