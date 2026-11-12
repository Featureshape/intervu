import { Clock, Effect, Layer, Ref } from "effect";
import * as Context from "effect/Context";
import { WaitingOrigin } from "./Protocol.ts";

/**
 * The daemon's memory of browsers looking for a Session that is not there:
 * each origin whose `GET /apps/session` lookup answered `session: null`, with
 * how often it asked and when it last did. The dormant badge polls every
 * second, so the signal already arrives - the daemon only remembers the
 * misses. In memory only, like plugin-reports: a diagnostic of the present,
 * gone on restart. A lookup that finds the origin's open Session clears it.
 */
export class WaitingOrigins extends Context.Service<
  WaitingOrigins,
  {
    /** Record one lookup that found no Session for `origin`. */
    readonly miss: (origin: string) => Effect.Effect<void>;
    /** Clear `origin`: a lookup found its open Session. */
    readonly found: (origin: string) => Effect.Effect<void>;
    /** Every waiting origin, most recently asked first. */
    readonly list: Effect.Effect<readonly WaitingOrigin[]>;
  }
>()("@intervu/WaitingOrigins") {
  static readonly layer = Layer.effect(
    WaitingOrigins,
    Effect.gen(function* () {
      const waitingRef = yield* Ref.make(new Map<string, WaitingOrigin>());

      const miss = (origin: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(waitingRef, (waiting) => {
            const previous = waiting.get(origin);
            return new Map(waiting).set(
              origin,
              WaitingOrigin.make({
                origin,
                count: (previous?.count ?? 0) + 1,
                lastSeenAt: now,
              }),
            );
          });
        });

      const found = (origin: string): Effect.Effect<void> =>
        Ref.update(waitingRef, (waiting) => {
          if (!waiting.has(origin)) {
            return waiting;
          }
          const next = new Map(waiting);
          next.delete(origin);
          return next;
        });

      const list = Ref.get(waitingRef).pipe(
        Effect.map((waiting) =>
          [...waiting.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
        ),
      );

      return { miss, found, list };
    }),
  );
}

/**
 * Whether `value` is an http(s) web origin - the only thing worth remembering
 * as waiting. Lookups can carry anything (a test, a stray client, an artifact
 * path); a did-you-mean line must never suggest `intervu` on a non-origin.
 */
export const isWebOrigin = (value: string): boolean => {
  const parsed = URL.parse(value);
  return (
    parsed !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:")
  );
};

/** How fresh a waiting origin must be to earn the did-you-mean line. */
export const waitingFreshMs = 90_000;

/**
 * The waiting origin the did-you-mean line names, or `null` when there is
 * nothing to say: the opened `origin` itself is waiting (the browser is
 * already looking right there), or no other origin asked within the
 * freshness window. Background tabs throttle timers hard, so the window is
 * generous rather than a poll interval.
 */
export const waitingElsewhere = (
  waiting: readonly {
    readonly origin: string;
    readonly lastSeenAt: number;
  }[],
  origin: string,
  now: number,
): string | null => {
  const fresh = waiting.filter(
    (entry) => now - entry.lastSeenAt <= waitingFreshMs,
  );
  if (fresh.some((entry) => entry.origin === origin)) {
    return null;
  }
  const newest = [...fresh].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  return newest?.origin ?? null;
};
