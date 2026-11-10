import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { AppConfig } from "../src/AppConfig.ts";
import { defaultDaemonPort } from "../src/DaemonPort.ts";

/** `AppConfig` resolved from exactly `env`, with nothing read from the process. */
const configFrom = (env: Record<string, string>) =>
  AppConfig.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provide(BunPath.layer),
  );

describe("AppConfig.browser", () => {
  it.effect("names the INTERVU_BROWSER program", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      expect(config.browser).toEqual(Option.some("/usr/bin/recorder"));
    }).pipe(
      Effect.provide(configFrom({ INTERVU_BROWSER: "/usr/bin/recorder" })),
    ),
  );

  it.effect("an unset INTERVU_BROWSER means the OS default browser", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      expect(config.browser).toEqual(Option.none());
    }).pipe(Effect.provide(configFrom({}))),
  );

  it.effect("an empty INTERVU_BROWSER counts as unset", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      expect(config.browser).toEqual(Option.none());
    }).pipe(Effect.provide(configFrom({ INTERVU_BROWSER: "" }))),
  );
});

describe("AppConfig.port", () => {
  it.effect("takes a valid INTERVU_PORT", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      expect(config.port).toBe(51990);
    }).pipe(Effect.provide(configFrom({ INTERVU_PORT: "51990" }))),
  );

  it.effect(
    "falls back to the default port the plugin uses when INTERVU_PORT is unset or invalid",
    () =>
      Effect.gen(function* () {
        for (const env of [
          {},
          { INTERVU_PORT: "" },
          { INTERVU_PORT: "65536" },
        ]) {
          const config = yield* AppConfig.pipe(Effect.provide(configFrom(env)));
          expect(config.port).toBe(defaultDaemonPort);
        }
      }),
  );
});
