import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  isWebOrigin,
  WaitingOrigins,
  waitingElsewhere,
  waitingFreshMs,
} from "../src/WaitingOrigins.ts";

/**
 * The daemon's waiting-origin memory: lookup misses tally per origin with
 * the last-seen time, a found Session clears its origin, and the pure
 * did-you-mean pick names the freshest other waiting origin - or nothing
 * when the opened origin is itself the one waiting.
 */

describe("WaitingOrigins", () => {
  it.effect("tallies misses per origin with the last-seen time", () =>
    Effect.gen(function* () {
      const waiting = yield* WaitingOrigins;
      yield* TestClock.adjust("1 second");
      yield* waiting.miss("https://app.test");
      yield* TestClock.adjust("2 seconds");
      yield* waiting.miss("https://app.test");
      yield* waiting.miss("http://localhost:5173");

      expect(yield* waiting.list).toEqual([
        { origin: "https://app.test", count: 2, lastSeenAt: 3_000 },
        { origin: "http://localhost:5173", count: 1, lastSeenAt: 3_000 },
      ]);
    }).pipe(Effect.provide(WaitingOrigins.layer)),
  );

  it.effect("a found Session clears its origin, and only its origin", () =>
    Effect.gen(function* () {
      const waiting = yield* WaitingOrigins;
      yield* waiting.miss("https://app.test");
      yield* waiting.miss("http://localhost:5173");
      yield* waiting.found("https://app.test");
      yield* waiting.found("https://never.waited");

      expect((yield* waiting.list).map((entry) => entry.origin)).toEqual([
        "http://localhost:5173",
      ]);
    }).pipe(Effect.provide(WaitingOrigins.layer)),
  );

  it.effect("lists the most recently asked origin first", () =>
    Effect.gen(function* () {
      const waiting = yield* WaitingOrigins;
      yield* waiting.miss("https://older.test");
      yield* TestClock.adjust("1 second");
      yield* waiting.miss("https://newer.test");

      expect((yield* waiting.list).map((entry) => entry.origin)).toEqual([
        "https://newer.test",
        "https://older.test",
      ]);
    }).pipe(Effect.provide(WaitingOrigins.layer)),
  );
});

describe("isWebOrigin", () => {
  it("keeps http(s) origins and drops everything else", () => {
    expect(isWebOrigin("http://localhost:5173")).toBe(true);
    expect(isWebOrigin("https://app.test")).toBe(true);
    for (const value of [
      "/tmp/artifact.html",
      "report.html",
      "file:///tmp/artifact.html",
      "localhost:5173",
      "",
    ]) {
      expect(isWebOrigin(value), value).toBe(false);
    }
  });
});

describe("waitingElsewhere", () => {
  const now = 1_000_000;

  it("names the freshest other waiting origin", () => {
    expect(
      waitingElsewhere(
        [
          { origin: "https://older.test", lastSeenAt: now - 10_000 },
          { origin: "https://newer.test", lastSeenAt: now - 1_000 },
        ],
        "http://localhost:5173",
        now,
      ),
    ).toBe("https://newer.test");
  });

  it("says nothing when the opened origin is itself waiting", () => {
    expect(
      waitingElsewhere(
        [
          { origin: "https://app.test", lastSeenAt: now - 1_000 },
          { origin: "https://other.test", lastSeenAt: now - 500 },
        ],
        "https://app.test",
        now,
      ),
    ).toBeNull();
  });

  it("ignores origins staler than the freshness window", () => {
    expect(
      waitingElsewhere(
        [
          {
            origin: "https://stale.test",
            lastSeenAt: now - waitingFreshMs - 1,
          },
        ],
        "http://localhost:5173",
        now,
      ),
    ).toBeNull();
    // A stale entry for the opened origin itself no longer suppresses the line.
    expect(
      waitingElsewhere(
        [
          {
            origin: "http://localhost:5173",
            lastSeenAt: now - waitingFreshMs - 1,
          },
          { origin: "https://fresh.test", lastSeenAt: now - 1_000 },
        ],
        "http://localhost:5173",
        now,
      ),
    ).toBe("https://fresh.test");
  });

  it("says nothing with no waiting origins at all", () => {
    expect(waitingElsewhere([], "http://localhost:5173", now)).toBeNull();
  });
});
