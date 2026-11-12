import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { parseAppUrl, schemePortWarning } from "../src/AppUrl.ts";

describe("parseAppUrl", () => {
  it("reads an http URL as the page and its origin", () => {
    expect(parseAppUrl("http://localhost:5173/settings?tab=a#top")).toEqual(
      Option.some({
        url: "http://localhost:5173/settings?tab=a#top",
        origin: "http://localhost:5173",
      }),
    );
  });

  it("gives every route of one dev server the same origin", () => {
    const origins = [
      "http://localhost:5173",
      "http://localhost:5173/",
      "http://localhost:5173/a/b",
      "HTTP://LOCALHOST:5173/x",
    ].map((raw) => Option.map(parseAppUrl(raw), (app) => app.origin));
    expect(origins).toEqual(
      Array.from({ length: 4 }, () => Option.some("http://localhost:5173")),
    );
  });

  it("reads an https URL", () => {
    expect(
      Option.map(parseAppUrl("https://127.0.0.1:8443/"), (app) => app.origin),
    ).toEqual(Option.some("https://127.0.0.1:8443"));
  });

  it("leaves file paths and scheme-less hosts to artifact mode", () => {
    for (const raw of [
      "report.html",
      "./out/report.html",
      "/tmp/report.html",
      "localhost:5173",
      "file:///tmp/report.html",
      "ftp://localhost/x",
      "",
    ]) {
      expect(parseAppUrl(raw), raw).toEqual(Option.none());
    }
  });
});

/** The parsed app a warning test starts from; the URL is always parseable. */
const appOf = (raw: string) => {
  const app = parseAppUrl(raw);
  expect(Option.isSome(app), `${raw} should parse as an app URL`).toBe(true);
  return Option.getOrElse(app, () => ({ url: raw, origin: raw }));
};

describe("schemePortWarning", () => {
  it("warns on http with explicit port 443, suggesting the https origin", () => {
    const warning = schemePortWarning(appOf("http://app.test:443/login"));
    expect(Option.isSome(warning)).toBe(true);
    const text = Option.getOrElse(warning, () => "");
    expect(text).toContain("http://app.test:443");
    expect(text).toContain("no browser will report");
    expect(text).toContain("intervu https://app.test");
  });

  it("warns on https with explicit port 80, suggesting the http origin", () => {
    const text = Option.getOrElse(
      schemePortWarning(appOf("https://app.test:80")),
      () => "",
    );
    expect(text).toContain("intervu http://app.test");
  });

  it("keeps IPv6 brackets in the suggested origin", () => {
    const text = Option.getOrElse(
      schemePortWarning(appOf("http://[::1]:443")),
      () => "",
    );
    expect(text).toContain("intervu https://[::1]");
  });

  it("stays quiet for origins a browser can report", () => {
    for (const raw of [
      "http://localhost:5173",
      "https://app.test",
      "http://app.test",
      "https://app.test:8443",
      "http://app.test:80",
      "https://app.test:443",
    ]) {
      expect(schemePortWarning(appOf(raw)), raw).toEqual(Option.none());
    }
  });
});
