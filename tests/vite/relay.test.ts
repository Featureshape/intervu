import { describe, expect, it } from "@effect/vitest";
import {
  type GuardInput,
  guardRequest,
  isRelayedRoute,
  ownOriginOf,
  ownSessionRouteKey,
} from "../../src/vite/relay.ts";

/**
 * The relay's same-origin guard, pinned without a dev server: every way a page
 * on another origin could reach `/__intervu/*` is a rejection, and the requests
 * the app's own page and the CLI make pass.
 */

const request = (overrides: Partial<GuardInput>): GuardInput => ({
  host: "localhost:5173",
  origin: undefined,
  secFetchSite: undefined,
  https: false,
  allowedHosts: [],
  ...overrides,
});

describe("guardRequest", () => {
  it("passes a request with neither Origin nor Sec-Fetch-Site (the CLI)", () => {
    expect(guardRequest(request({}))).toBeNull();
  });

  it("passes the dev server's own origin", () => {
    expect(
      guardRequest(
        request({
          origin: "http://localhost:5173",
          secFetchSite: "same-origin",
        }),
      ),
    ).toBeNull();
    expect(
      guardRequest(request({ https: true, origin: "https://localhost:5173" })),
    ).toBeNull();
  });

  it("rejects another origin, scheme or port", () => {
    for (const origin of [
      "http://evil.example",
      "https://localhost:5173",
      "http://localhost:5174",
      "null",
    ]) {
      expect(guardRequest(request({ origin }))).toBe("foreign-origin");
    }
  });

  it("rejects a cross-site or same-site fetch without an Origin", () => {
    expect(guardRequest(request({ secFetchSite: "cross-site" }))).toBe(
      "cross-site-fetch",
    );
    expect(guardRequest(request({ secFetchSite: "same-site" }))).toBe(
      "cross-site-fetch",
    );
    expect(guardRequest(request({ secFetchSite: "none" }))).toBeNull();
  });

  it("rejects a foreign Host even when Origin matches it (DNS rebinding)", () => {
    expect(
      guardRequest(
        request({
          host: "evil.example:5173",
          origin: "http://evil.example:5173",
        }),
      ),
    ).toBe("foreign-host");
    expect(guardRequest(request({ host: undefined }))).toBe("foreign-host");
  });

  it("trusts loopback names, IP literals and Vite's allowedHosts", () => {
    for (const host of [
      "127.0.0.1:5173",
      "[::1]:5173",
      "app.localhost:5173",
      "192.168.1.20:5173",
    ]) {
      expect(guardRequest(request({ host }))).toBeNull();
    }
    expect(
      guardRequest(request({ host: "dev.test", allowedHosts: ["dev.test"] })),
    ).toBeNull();
    expect(
      guardRequest(
        request({ host: "a.dev.test", allowedHosts: [".dev.test"] }),
      ),
    ).toBeNull();
    expect(
      guardRequest(request({ host: "evil.example", allowedHosts: true })),
    ).toBeNull();
  });
});

describe("isRelayedRoute", () => {
  it("relays only the daemon routes the page needs", () => {
    expect(isRelayedRoute("GET", "/health")).toBe(true);
  });

  it("refuses every other route, method or query", () => {
    expect(isRelayedRoute("POST", "/health")).toBe(false);
    expect(isRelayedRoute("GET", "/health?x=1")).toBe(false);
    expect(isRelayedRoute("POST", "/sessions")).toBe(false);
    expect(isRelayedRoute("GET", "/s/abc/a/index.html")).toBe(false);
  });
});

describe("ownOriginOf", () => {
  it("is the origin a page reached the dev server by", () => {
    expect(ownOriginOf({ host: "localhost:5173", https: false })).toBe(
      "http://localhost:5173",
    );
    expect(ownOriginOf({ host: "127.0.0.1:4443", https: true })).toBe(
      "https://127.0.0.1:4443",
    );
  });
});

describe("ownSessionRouteKey", () => {
  it("names the Session key of a feedback POST", () => {
    expect(ownSessionRouteKey("POST", "/s/0123456789abcdef/feedback")).toBe(
      "0123456789abcdef",
    );
  });

  it("names the Session key of its event stream", () => {
    expect(ownSessionRouteKey("GET", "/s/0123456789abcdef/events")).toBe(
      "0123456789abcdef",
    );
  });

  it("is null for any other method, path or key shape", () => {
    expect(
      ownSessionRouteKey("GET", "/s/0123456789abcdef/feedback"),
    ).toBeNull();
    expect(ownSessionRouteKey("POST", "/s/0123456789abcdef/events")).toBeNull();
    expect(ownSessionRouteKey("GET", "/s/not-a-key/events")).toBeNull();
    expect(ownSessionRouteKey("POST", "/s/0123456789abcdef/end")).toBeNull();
    expect(ownSessionRouteKey("POST", "/s/not-a-key/feedback")).toBeNull();
    expect(ownSessionRouteKey("POST", "/health")).toBeNull();
  });
});
