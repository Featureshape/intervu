import { describe, expect, it } from "@effect/vitest";
import { classifyLookup } from "../../src/overlay/lookupState.ts";

/**
 * The badge's reading of a Session lookup: an open Session, no Session, no
 * daemon behind the dev server, or a dev server that refused the page - and
 * an old dev server's unclassified answers stay today's "no Session", so a
 * new overlay against an old plugin claims nothing it was not told.
 */

describe("classifyLookup", () => {
  it("finds the open Session's key", () => {
    expect(
      classifyLookup(200, {
        session: { key: "0123456789abcdef", status: "open" },
      }),
    ).toEqual({ kind: "open", key: "0123456789abcdef" });
  });

  it("reads a daemon's no-Session answer as no Session", () => {
    expect(classifyLookup(200, { session: null })).toEqual({
      kind: "no-session",
    });
    expect(
      classifyLookup(200, { session: { key: "abc", status: "ended" } }),
    ).toEqual({ kind: "no-session" });
  });

  it("reads the relay's unreachable marker as no daemon, with its ports", () => {
    expect(
      classifyLookup(200, {
        session: null,
        daemon: "unreachable",
        ports: [51789],
      }),
    ).toEqual({ kind: "no-daemon", ports: [51789] });
  });

  it("turns a classified 403 into the refusal, in plain words", () => {
    expect(
      classifyLookup(403, {
        error: {
          tag: "ForeignOrigin",
          message: "refused",
          reason: "foreign-page-origin",
          pageOrigin: "https://app.test:8443",
        },
      }),
    ).toEqual({
      kind: "refused",
      reason: "page origin doesn't match what the dev server trusts",
      pageOrigin: "https://app.test:8443",
    });
  });

  it("names an unknown rejection code as it came", () => {
    expect(
      classifyLookup(403, { error: { reason: "brand-new-rejection" } }),
    ).toEqual({
      kind: "refused",
      reason: "brand-new-rejection",
      pageOrigin: undefined,
    });
  });

  it("reads an old relay's unclassified 403 as no Session", () => {
    expect(
      classifyLookup(403, {
        error: { tag: "ForeignOrigin", message: "refused" },
      }),
    ).toEqual({ kind: "no-session" });
  });

  it("reads any other failure as no Session", () => {
    expect(classifyLookup(404, { error: null })).toEqual({
      kind: "no-session",
    });
    expect(classifyLookup(502, "bad gateway")).toEqual({ kind: "no-session" });
  });
});
