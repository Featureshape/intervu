import { describe, expect, it } from "@effect/vitest";
import {
  guardRefusalIn,
  plainWordsOf,
  rejectionInPlainWords,
} from "../../src/vite/guardRefusal.ts";

/**
 * Reading the guard's refusal back out of a 403 body, the overlay's side of
 * the contract: a classified body yields the reason and the presented origins,
 * an old dev server's unclassified body yields nothing, and every rejection
 * code has plain words for the badge's card.
 */

describe("plainWordsOf", () => {
  it("names every rejection in plain words", () => {
    expect(plainWordsOf("foreign-page-origin")).toBe(
      "page origin doesn't match what the dev server trusts",
    );
    for (const words of Object.values(rejectionInPlainWords)) {
      expect(words).not.toMatch(/foreign|fetch/);
    }
  });

  it("falls back to the code itself for one it does not know", () => {
    expect(plainWordsOf("brand-new-rejection")).toBe("brand-new-rejection");
  });
});

describe("guardRefusalIn", () => {
  it("reads the reason and the presented origins", () => {
    expect(
      guardRefusalIn({
        error: {
          tag: "ForeignOrigin",
          message: "refused",
          reason: "foreign-page-origin",
          origin: "https://app.test",
          pageOrigin: "https://app.test:8443",
        },
      }),
    ).toEqual({
      reason: "foreign-page-origin",
      origin: "https://app.test",
      pageOrigin: "https://app.test:8443",
    });
  });

  it("leaves out the origins the body does not carry", () => {
    expect(guardRefusalIn({ error: { reason: "foreign-host" } })).toEqual({
      reason: "foreign-host",
      origin: undefined,
      pageOrigin: undefined,
    });
  });

  it("reads nothing from an old dev server's unclassified 403", () => {
    for (const body of [
      { error: { tag: "ForeignOrigin", message: "refused" } },
      { error: null },
      "forbidden",
      null,
    ]) {
      expect(guardRefusalIn(body)).toBeNull();
    }
  });
});
