import { describe, expect, it } from "@effect/vitest";
import {
  describeRejection,
  forwardedParamOf,
  type GuardInput,
  type GuardVerdict,
  guardRefusalBodyOf,
  guardRequest,
  isRelayedRoute,
  ownSessionRouteKey,
  relayTargetOf,
} from "../../src/vite/relay.ts";

/**
 * The relay's same-origin guard, pinned without a dev server: every way a page
 * on another origin could reach `/__intervu/*` is a rejection, and the requests
 * the app's own page and the CLI make pass - also through a reverse proxy that
 * terminates TLS, where the dev server sees plain http but the browser is on
 * https.
 */

const request = (overrides: Partial<GuardInput>): GuardInput => ({
  host: "localhost:5173",
  origin: undefined,
  secFetchSite: undefined,
  forwardedHost: undefined,
  forwardedProto: undefined,
  pageOrigin: undefined,
  https: false,
  allowedHosts: [],
  ...overrides,
});

const passes = (pageOrigin: string): GuardVerdict => ({
  pass: true,
  pageOrigin,
});

const rejects = (rejection: string) => ({ pass: false, rejection });

describe("guardRequest", () => {
  it("passes a request with neither Origin nor Sec-Fetch-Site (the CLI)", () => {
    expect(guardRequest(request({}))).toEqual(passes("http://localhost:5173"));
  });

  it("passes the dev server's own origin", () => {
    expect(
      guardRequest(
        request({
          origin: "http://localhost:5173",
          secFetchSite: "same-origin",
        }),
      ),
    ).toEqual(passes("http://localhost:5173"));
    expect(
      guardRequest(request({ https: true, origin: "https://localhost:5173" })),
    ).toEqual(passes("https://localhost:5173"));
  });

  it("rejects another host, port or a non-web origin", () => {
    for (const origin of [
      "http://evil.example",
      "http://localhost:5174",
      "http://127.0.0.1:5173",
      "null",
      "file:///etc/hosts",
    ]) {
      expect(guardRequest(request({ origin }))).toEqual(
        rejects("foreign-origin"),
      );
    }
  });

  it("rejects a cross-site or same-site fetch without an Origin", () => {
    expect(guardRequest(request({ secFetchSite: "cross-site" }))).toEqual(
      rejects("cross-site-fetch"),
    );
    expect(guardRequest(request({ secFetchSite: "same-site" }))).toEqual(
      rejects("cross-site-fetch"),
    );
    expect(guardRequest(request({ secFetchSite: "none" }))).toEqual(
      passes("http://localhost:5173"),
    );
  });

  it("rejects a foreign Host even when Origin matches it (DNS rebinding)", () => {
    expect(
      guardRequest(
        request({
          host: "evil.example:5173",
          origin: "http://evil.example:5173",
        }),
      ),
    ).toEqual(rejects("foreign-host"));
    expect(guardRequest(request({ host: undefined }))).toEqual(
      rejects("foreign-host"),
    );
  });

  it("trusts loopback names, IP literals and Vite's allowedHosts", () => {
    for (const host of [
      "127.0.0.1:5173",
      "[::1]:5173",
      "app.localhost:5173",
      "192.168.1.20:5173",
    ]) {
      expect(guardRequest(request({ host })).pass).toBe(true);
    }
    expect(
      guardRequest(request({ host: "dev.test", allowedHosts: ["dev.test"] }))
        .pass,
    ).toBe(true);
    expect(
      guardRequest(request({ host: "a.dev.test", allowedHosts: [".dev.test"] }))
        .pass,
    ).toBe(true);
    expect(
      guardRequest(request({ host: "evil.example", allowedHosts: true })).pass,
    ).toBe(true);
  });

  it("passes the browser's https origin behind a TLS-terminating proxy", () => {
    // nginx in front of an http dev server: the browser is on
    // https://app.test, the dev server sees `Host: app.test:443`.
    const behindProxy = {
      host: "app.test:443",
      allowedHosts: ["app.test"],
      secFetchSite: "same-origin",
    };
    expect(
      guardRequest(
        request({
          ...behindProxy,
          origin: "https://app.test",
          pageOrigin: "https://app.test",
        }),
      ),
    ).toEqual(passes("https://app.test"));
    // The same with a proxy that forwards the bare hostname.
    expect(
      guardRequest(
        request({
          ...behindProxy,
          host: "app.test",
          pageOrigin: "https://app.test",
        }),
      ),
    ).toEqual(passes("https://app.test"));
  });

  it("matches a proxy's forwarded host when it rewrites Host", () => {
    const rewritten = {
      host: "localhost:5173",
      forwardedHost: "app.test",
      forwardedProto: "https",
      allowedHosts: ["app.test"],
    };
    expect(
      guardRequest(request({ ...rewritten, origin: "https://app.test" })),
    ).toEqual(passes("https://app.test"));
    // With no origin named, the forwarded scheme and host make the origin.
    expect(guardRequest(request(rewritten))).toEqual(
      passes("https://app.test"),
    );
    // A forwarded host the server does not trust earns nothing.
    expect(
      guardRequest(
        request({
          ...rewritten,
          allowedHosts: [],
          origin: "https://app.test",
        }),
      ),
    ).toEqual(rejects("foreign-origin"));
  });

  it("takes the page origin the overlay names, normalised", () => {
    expect(
      guardRequest(request({ pageOrigin: "HTTP://LocalHost:5173" })),
    ).toEqual(passes("http://localhost:5173"));
  });

  it("rejects a page origin that is not this dev server or disagrees with Origin", () => {
    for (const pageOrigin of [
      "http://localhost:3000",
      "http://evil.example:5173",
      "null",
    ]) {
      expect(guardRequest(request({ pageOrigin }))).toEqual(
        rejects("foreign-page-origin"),
      );
    }
    expect(
      guardRequest(
        request({
          host: "localhost:5173",
          origin: "http://localhost:5173",
          pageOrigin: "https://localhost:5173",
        }),
      ),
    ).toEqual(rejects("foreign-page-origin"));
  });
});

describe("describeRejection", () => {
  it("says why and what the guard saw", () => {
    expect(
      describeRejection(
        "GET",
        "/overlay.js",
        "foreign-origin",
        request({ host: "app.test:443", origin: "https://evil.example" }),
      ),
    ).toBe(
      "[intervu] refused GET /__intervu/overlay.js: its Origin is not an address this dev server answers to - behind a proxy, forward the browser's Host (or X-Forwarded-Host) and add the hostname to server.allowedHosts (Host: app.test:443, Origin: https://evil.example)",
    );
  });
});

describe("guardRefusalBodyOf", () => {
  it("carries the reason and the origins the request presented", () => {
    expect(
      JSON.parse(
        guardRefusalBodyOf(
          "foreign-page-origin",
          request({
            origin: "https://app.test",
            pageOrigin: "https://app.test:8443",
          }),
        ),
      ),
    ).toEqual({
      error: {
        tag: "ForeignOrigin",
        message:
          "intervu only answers the dev server's own origin (foreign-page-origin)",
        reason: "foreign-page-origin",
        origin: "https://app.test",
        pageOrigin: "https://app.test:8443",
      },
    });
  });

  it("drops the origins the request did not present", () => {
    expect(JSON.parse(guardRefusalBodyOf("foreign-host", request({})))).toEqual(
      {
        error: {
          tag: "ForeignOrigin",
          message:
            "intervu only answers the dev server's own origin (foreign-host)",
          reason: "foreign-host",
        },
      },
    );
  });

  it("never echoes the server's trusted-host list", () => {
    const body = guardRefusalBodyOf(
      "foreign-origin",
      request({
        origin: "https://evil.example",
        allowedHosts: ["secret-internal.test", "app.test"],
      }),
    );
    expect(body).not.toContain("secret-internal.test");
    expect(body).not.toContain("allowedHosts");
  });
});

describe("forwardedParamOf", () => {
  it("reads host and proto off the first Forwarded element", () => {
    const header = 'for=192.0.2.60;proto=https;host="app.test", for=10.0.0.1';
    expect(forwardedParamOf(header, "host")).toBe("app.test");
    expect(forwardedParamOf(header, "proto")).toBe("https");
    expect(forwardedParamOf("for=10.0.0.1", "host")).toBeUndefined();
    expect(forwardedParamOf(undefined, "proto")).toBeUndefined();
  });
});

describe("relayTargetOf", () => {
  it("splits the path from the page origin the query names", () => {
    expect(relayTargetOf("/session?origin=https%3A%2F%2Fapp.test&x=1")).toEqual(
      { path: "/session", pageOrigin: "https://app.test" },
    );
    expect(relayTargetOf("/overlay.js")).toEqual({
      path: "/overlay.js",
      pageOrigin: undefined,
    });
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
