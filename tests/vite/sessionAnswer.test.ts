import { describe, expect, it } from "@effect/vitest";
import { chooseLookupAnswer } from "../../src/vite/sessionAnswer.ts";

/**
 * The relay's choice among several daemons' lookup answers (the port-range
 * fan-out): an open Session wins, the most recently active one breaks a
 * two-daemon tie - with every open port named so the relay can warn - and
 * with nothing open, an answer naming an ended Session beats a bare null.
 */

const open = (key: string, lastActivityAt: number) => ({
  session: { key, status: "open", lastActivityAt },
});

describe("chooseLookupAnswer", () => {
  it("prefers the daemon holding an open Session", () => {
    const choice = chooseLookupAnswer([
      { port: 51789, answer: { session: null } },
      { port: 51790, answer: open("0123456789abcdef", 5_000) },
    ]);
    expect(choice).toMatchObject({
      kind: "open",
      port: 51790,
      key: "0123456789abcdef",
      openPorts: [51790],
    });
  });

  it("breaks a two-daemon tie by the most recent activity, naming both", () => {
    const choice = chooseLookupAnswer([
      { port: 51789, answer: open("0123456789abcdef", 1_000) },
      { port: 51790, answer: open("0123456789abcdef", 9_000) },
    ]);
    expect(choice).toMatchObject({
      kind: "open",
      port: 51790,
      openPorts: [51789, 51790],
    });
  });

  it("treats a missing activity stamp as oldest (an older daemon)", () => {
    const choice = chooseLookupAnswer([
      {
        port: 51789,
        answer: { session: { key: "0123456789abcdef", status: "open" } },
      },
      { port: 51790, answer: open("0123456789abcdef", 1) },
    ]);
    expect(choice).toMatchObject({ kind: "open", port: 51790 });
  });

  it("with nothing open, an ended Session beats a bare null", () => {
    const choice = chooseLookupAnswer([
      { port: 51789, answer: { session: null } },
      {
        port: 51790,
        answer: { session: { key: "0123456789abcdef", status: "ended" } },
      },
    ]);
    expect(choice).toMatchObject({ kind: "none", port: 51790 });
  });

  it("with no answers at all, chooses nothing", () => {
    expect(chooseLookupAnswer([])).toEqual({
      kind: "none",
      port: null,
      answer: null,
    });
  });
});
