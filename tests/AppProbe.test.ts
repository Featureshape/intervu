import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http";
import * as AppProbe from "../src/AppProbe.ts";
import { AppUnreachable } from "../src/Errors.ts";

/**
 * What `intervu <url>` asks the running app (behaviours 6, 7): any HTTP answer
 * means the app is up, and only the daemon's health body through the plugin's
 * relay means the plugin is installed. A stub client plays each answer.
 */

const app = { url: "http://localhost:5173/", origin: "http://localhost:5173" };

const answering = (answer: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, answer())),
    ),
  );

/** A stub client whose every request is refused before any HTTP answer. */
const refusing = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: "connect ECONNREFUSED",
        }),
      }),
    ),
  ),
);

/** A stub client that never answers. */
const silent = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.never),
);

describe("AppProbe.requireAnswer", () => {
  it.effect("counts a 404 or a 500 as an app that answers", () =>
    Effect.gen(function* () {
      for (const status of [404, 500]) {
        const exit = yield* AppProbe.requireAnswer(app).pipe(
          Effect.provide(answering(() => new Response("x", { status }))),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
      }
    }),
  );

  it.effect("fails with AppUnreachable when the connection is refused", () =>
    Effect.gen(function* () {
      const error = yield* AppProbe.requireAnswer(app).pipe(
        Effect.provide(refusing),
        Effect.flip,
      );
      expect(error).toEqual(new AppUnreachable({ url: app.url }));
    }),
  );

  it.effect(
    "fails with AppUnreachable when the app does not answer in time",
    () =>
      Effect.gen(function* () {
        const fiber = yield* AppProbe.requireAnswer(app).pipe(
          Effect.provide(silent),
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust("5 seconds");
        const error = yield* Fiber.join(fiber);
        expect(error).toEqual(new AppUnreachable({ url: app.url }));
      }),
  );
});

describe("AppProbe.pluginAnswers", () => {
  it.effect("is true only for the daemon's health body", () =>
    Effect.gen(function* () {
      const health = JSON.stringify({ ok: true, version: "0.0.0" });
      const answers = yield* Effect.forEach(
        [
          () => new Response(health),
          () => new Response("<!doctype html><html></html>"),
          () => new Response(health, { status: 502 }),
        ],
        (answer) =>
          AppProbe.pluginAnswers(app.origin).pipe(
            Effect.provide(answering(answer)),
          ),
      );
      expect(answers).toEqual([true, false, false]);
    }),
  );
});
