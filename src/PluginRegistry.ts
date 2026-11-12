import { Clock, Effect, Layer, Ref } from "effect";
import * as Context from "effect/Context";
import { type PluginReportRequest, StatusPlugin } from "./Protocol.ts";

/**
 * The daemon's memory of the `intervu/vite` plugins that reported in: one
 * sighting per dev-server origin, replaced by each newer report and stamped
 * with the daemon's clock. In memory only, by design - a plugin-report is a
 * diagnostic of the present, and a stale one surviving a restart would lie,
 * which is the exact disease the reports treat. A daemon restart starts clean.
 */
export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    /** Take one plugin's report, replacing its previous sighting. */
    readonly report: (report: PluginReportRequest) => Effect.Effect<void>;
    /** Every sighting, newest-seen first. */
    readonly sightings: Effect.Effect<readonly StatusPlugin[]>;
  }
>()("@intervu/PluginRegistry") {
  static readonly layer = Layer.effect(
    PluginRegistry,
    Effect.gen(function* () {
      const sightingsRef = yield* Ref.make(new Map<string, StatusPlugin>());

      const report = (incoming: PluginReportRequest): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(sightingsRef, (sightings) =>
            new Map(sightings).set(
              incoming.origin,
              StatusPlugin.make({
                origin: incoming.origin,
                seenOrigins: incoming.seenOrigins,
                refusals: incoming.refusals,
                lastSeenAt: now,
              }),
            ),
          );
        });

      const sightings = Ref.get(sightingsRef).pipe(
        Effect.map((map) =>
          [...map.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
        ),
      );

      return { report, sightings };
    }),
  );
}
