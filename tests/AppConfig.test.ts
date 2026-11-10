import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { AppConfig } from "../src/AppConfig.ts";

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
