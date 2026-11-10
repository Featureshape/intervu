import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as AppProbe from "../src/AppProbe.ts";

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
