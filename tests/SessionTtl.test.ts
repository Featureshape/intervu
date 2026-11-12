import { describe, expect, it } from "@effect/vitest";
import { Session, SessionKey } from "../src/Session.ts";
import {
  countsAsOpen,
  defaultSessionTtlSeconds,
  isExpired,
} from "../src/SessionTtl.ts";

/**
 * The idle-TTL arithmetic, pinned pure: strictly past the TTL expires, at
 * the boundary does not, and only `open` Sessions ever count as live.
 */

const hour = 60 * 60 * 1000;

describe("isExpired", () => {
  it("expires strictly past the TTL, not at the boundary", () => {
    expect(isExpired(0, hour, hour)).toBe(false);
    expect(isExpired(0, hour + 1, hour)).toBe(true);
    expect(isExpired(hour, hour, hour)).toBe(false);
  });

  it("defaults to 24 hours", () => {
    expect(defaultSessionTtlSeconds).toBe(86_400);
  });
});

describe("countsAsOpen", () => {
  const session = (status: "open" | "ended", lastActivityAt: number) =>
    new Session({
      key: SessionKey.make("abc0000000000000"),
      path: "/tmp/a.html",
      status,
      kind: "artifact",
      lastActivityAt,
    });

  it("open and inside the TTL is live; idle past it is not", () => {
    expect(countsAsOpen(session("open", 0), hour, hour)).toBe(true);
    expect(countsAsOpen(session("open", 0), hour + 1, hour)).toBe(false);
  });

  it("an ended Session never counts as open, however fresh", () => {
    expect(countsAsOpen(session("ended", hour), hour, hour)).toBe(false);
  });
});
