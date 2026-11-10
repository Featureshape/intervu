import { describe, expect, it } from "@effect/vitest";
import { daemonPortFrom, defaultDaemonPort } from "../src/DaemonPort.ts";

/**
 * The CLI's `AppConfig` and the plugin both read `INTERVU_PORT` through this
 * parse: a valid port wins, anything else falls back to the shared default.
 */
describe("daemonPortFrom", () => {
  it("takes a valid port", () => {
    expect(daemonPortFrom("51990")).toBe(51990);
    expect(daemonPortFrom("1")).toBe(1);
    expect(daemonPortFrom("65535")).toBe(65535);
  });

  it("falls back to the default when unset or invalid", () => {
    for (const raw of [undefined, "", " ", "abc", "0", "65536", "80.5", "-1"]) {
      expect(daemonPortFrom(raw)).toBe(defaultDaemonPort);
    }
  });
});
