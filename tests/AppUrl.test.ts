import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { parseAppUrl } from "../src/AppUrl.ts";

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
