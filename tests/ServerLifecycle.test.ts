import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { AppConfig, version } from "../src/AppConfig.ts";
import { isStaleVersion, ServerLifecycle } from "../src/ServerLifecycle.ts";

/**
 * The takeover predicate (ADR 0015): take over iff the running daemon is
 * strictly older than the client, compared as numeric `major.minor.patch`
 * tuples. Equal-or-newer is reused; an unparseable running version is stale.
 */
describe("isStaleVersion", () => {
  it("a strictly-older running version is stale", () => {
    expect(isStaleVersion("0.0.0", "0.0.1")).toBe(true);
    expect(isStaleVersion("0.1.0", "0.2.0")).toBe(true);
    expect(isStaleVersion("1.9.9", "2.0.0")).toBe(true);
    expect(isStaleVersion("1.2.3", "1.2.4")).toBe(true);
  });

  it("an equal version is reused, not stale", () => {
    expect(isStaleVersion("0.0.0", "0.0.0")).toBe(false);
    expect(isStaleVersion("1.2.3", "1.2.3")).toBe(false);
  });

  it("a strictly-newer running version is reused, not stale", () => {
    expect(isStaleVersion("0.0.2", "0.0.1")).toBe(false);
    expect(isStaleVersion("2.0.0", "1.9.9")).toBe(false);
    expect(isStaleVersion("1.2.4", "1.2.3")).toBe(false);
  });

  it("an unparseable running version counts as stale", () => {
    expect(isStaleVersion("", "0.0.1")).toBe(true);
    expect(isStaleVersion("nope", "0.0.1")).toBe(true);
    expect(isStaleVersion("1.2", "0.0.1")).toBe(true);
    expect(isStaleVersion("1.2.3.4", "0.0.1")).toBe(true);
  });

  it("an unparseable client version never evicts a running daemon", () => {
    expect(isStaleVersion("0.0.0", "garbage")).toBe(false);
  });

  it("this build's own version is comparable, and newer than the old hardcoded one", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(isStaleVersion(version, version)).toBe(false);
    // 0.2.0 and earlier always reported 0.0.0, so those daemons must be replaced.
    expect(isStaleVersion("0.0.0", version)).toBe(true);
  });
});

/**
 * The health check during daemon startup: `BunHttpServer` binds the port before
 * the routes are mounted and answers `404` in between, so a `/health` that `404`s
 * is retried. A stub client plays that sequence with no real daemon involved.
 */
describe("ServerLifecycle health check", () => {
  const health = JSON.stringify({ ok: true, version: "0.0.0" });

  const layerAnswering = (answer: (attempt: number) => Response) => {
    let attempts = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        return HttpClientResponse.fromWeb(request, answer(attempts));
      }),
    );
    const layer = ServerLifecycle.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(
        Layer.succeed(AppConfig, {
          version: "0.0.0",
          hostname: "127.0.0.1",
          port: 1,
          idleTimeout: Duration.seconds(30),
          stateDir: "/state",
          stateFile: "/state/state.json",
          pidFile: "/state/server.pid",
          logFile: "/state/server.log",
          homeDir: Option.some("/home/tester"),
          currentDir: "/project",
          browser: Option.none(),
        }),
      ),
      Layer.provide(BunFileSystem.layer),
    );
    return { layer, attempts: () => attempts };
  };

  it.live("waits out the startup 404 until the routes are mounted", () => {
    const { layer, attempts } = layerAnswering((attempt) =>
      attempt <= 3
        ? new Response("not found", { status: 404 })
        : new Response(health),
    );
    return Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycle;
      const result = yield* lifecycle.requireHealthy;
      expect(result.version).toBe("0.0.0");
      expect(attempts()).toBe(4);
    }).pipe(Effect.provide(layer));
  });

  it.live("does not retry a failure other than the startup 404", () => {
    const { layer, attempts } = layerAnswering(
      () => new Response("broken", { status: 500 }),
    );
    return Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycle;
      const exit = yield* Effect.exit(lifecycle.requireHealthy);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts()).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("gives up on a port that only ever answers 404", () => {
    const { layer, attempts } = layerAnswering(
      () => new Response("not found", { status: 404 }),
    );
    return Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycle;
      const exit = yield* Effect.exit(lifecycle.requireHealthy);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts()).toBe(21);
    }).pipe(Effect.provide(layer));
  });
});
