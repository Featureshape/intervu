import { createHash } from "node:crypto";
import { Console, Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Context from "effect/Context";
import { AppConfig } from "./AppConfig.ts";

/**
 * Where `intervu poll` puts each delivered DOM snapshot (ADR 0021), so the agent
 * reads one only when it needs to instead of receiving a whole page per Feedback.
 *
 * Snapshots land in `<stateDir>/snapshots/<handle-hash>/<content-hash>.html`,
 * where the handle is the Session's: an artifact's realpath or an app's origin.
 * The content hash means identical snapshots share one file, and each Session
 * keeps only its newest `KEEP` files. Both the directories and the files are
 * owner-only, because a rendered page can hold private data.
 *
 * `save` never fails. By the time the CLI holds a snapshot the daemon has already
 * drained its Feedback, so failing here would lose the human's message: `None`
 * tells the caller to deliver the snapshot inline instead. Problems go to stderr,
 * because stdout carries only the TOON document.
 */

const KEEP = 20;

const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export class SnapshotFiles extends Context.Service<
  SnapshotFiles,
  {
    readonly save: (
      handle: string,
      html: string,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("@intervu/SnapshotFiles") {
  static readonly layer = Layer.effect(
    SnapshotFiles,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const prune = (dir: string) =>
        Effect.gen(function* () {
          const names = yield* fs.readDirectory(dir);
          const files = yield* Effect.forEach(names, (name) => {
            const file = path.join(dir, name);
            return fs.stat(file).pipe(
              Effect.map((info) => ({
                file,
                modified: Option.match(info.mtime, {
                  onNone: () => 0,
                  onSome: (mtime) => mtime.getTime(),
                }),
              })),
            );
          });
          const stale = files
            .toSorted((a, b) => b.modified - a.modified)
            .slice(KEEP);
          yield* Effect.forEach(stale, ({ file }) => fs.remove(file));
        });

      const save = (handle: string, html: string) =>
        Effect.gen(function* () {
          const dir = path.join(
            config.stateDir,
            "snapshots",
            shortHash(handle),
          );
          const file = path.join(dir, `${shortHash(html)}.html`);
          yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(file, html, { mode: 0o600 });
          // The snapshot is safely on disk, so a failed clean-up costs nothing
          // now and can be retried by the next save.
          yield* prune(dir).pipe(
            Effect.catch((error) =>
              Console.error(`could not prune DOM snapshots: ${error.message}`),
            ),
          );
          return Option.some(file);
        }).pipe(
          Effect.catch((error) =>
            Console.error(
              `could not save DOM snapshot, delivering it inline: ${error.message}`,
            ).pipe(Effect.as(Option.none<string>())),
          ),
        );

      return { save };
    }),
  );
}
