import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { PluginRegistry } from "../src/PluginRegistry.ts";
import { PluginReportRequest } from "../src/Protocol.ts";

/**
 * The daemon's in-memory plugin registry: each report replaces that plugin's
 * previous sighting and is stamped with the daemon's clock, sightings list
 * newest-seen first, and nothing persists - a fresh layer starts clean.
 */

const report = (origin: string, seenOrigins: readonly string[]) =>
  PluginReportRequest.make({ origin, seenOrigins, refusals: [] });

describe("PluginRegistry", () => {
  it.effect("a newer report replaces the plugin's previous sighting", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      yield* TestClock.adjust("1 second");
      yield* registry.report(report("http://localhost:5173", []));
      yield* TestClock.adjust("5 seconds");
      yield* registry.report(
        report("http://localhost:5173", ["https://app.test"]),
      );

      const sightings = yield* registry.sightings;
      expect(sightings).toHaveLength(1);
      expect(sightings[0]).toMatchObject({
        origin: "http://localhost:5173",
        seenOrigins: ["https://app.test"],
        lastSeenAt: 6_000,
      });
    }).pipe(Effect.provide(PluginRegistry.layer)),
  );

  it.effect("sightings list newest-seen first, one per dev server", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      yield* TestClock.adjust("1 second");
      yield* registry.report(report("http://localhost:5173", []));
      yield* TestClock.adjust("1 second");
      yield* registry.report(report("http://localhost:5174", []));

      const sightings = yield* registry.sightings;
      expect(sightings.map((sighting) => sighting.origin)).toEqual([
        "http://localhost:5174",
        "http://localhost:5173",
      ]);
    }).pipe(Effect.provide(PluginRegistry.layer)),
  );

  it.effect("keeps the refusal tallies as the plugin sent them", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      yield* registry.report(
        PluginReportRequest.make({
          origin: "http://localhost:5173",
          seenOrigins: [],
          refusals: [
            {
              reason: "foreign-page-origin",
              pageOrigin: "https://app.test",
              count: 7,
              lastAt: 123_456,
            },
          ],
        }),
      );

      const sightings = yield* registry.sightings;
      expect(sightings[0]?.refusals).toEqual([
        {
          reason: "foreign-page-origin",
          pageOrigin: "https://app.test",
          count: 7,
          lastAt: 123_456,
        },
      ]);
    }).pipe(Effect.provide(PluginRegistry.layer)),
  );
});
