import { describe, expect, it } from "@effect/vitest";
import {
  daemonPortFrom,
  daemonPortsFrom,
  defaultDaemonPort,
  rangePorts,
} from "../src/DaemonPort.ts";

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

/**
 * The range-scan predicate: an explicit `INTERVU_PORT` pins everything to
 * exactly that port, no range scan; otherwise the whole fixed coexistence
 * range 51789-51798 is in play, in bind order.
 */
describe("daemonPortsFrom", () => {
  it("pins to exactly the explicit port", () => {
    expect(daemonPortsFrom("51990")).toEqual([51990]);
    expect(daemonPortsFrom("51789")).toEqual([51789]);
  });

  it("scans the whole fixed range when unset or invalid", () => {
    expect(daemonPortsFrom(undefined)).toEqual([
      51789, 51790, 51791, 51792, 51793, 51794, 51795, 51796, 51797, 51798,
    ]);
    expect(daemonPortsFrom("garbage")).toEqual(rangePorts);
  });
});
