import { describe, expect, it } from "@effect/vitest";
import { diagnoseLookup, failedCount } from "../src/Doctor.ts";

/**
 * Doctor's reading of the overlay's exact lookup answer, pinned without a
 * dev server: a non-JSON answer is a missing plugin, a classified 403 fails
 * the guard with the dev server's own reason, the relay's unreachable marker
 * fails the daemon check naming the port, and a 200 settles the Session
 * check - open passes, ended and absent fail with the reopen hint.
 */

const origin = "https://app.test";

describe("diagnoseLookup", () => {
  it("reads a non-JSON answer as a missing plugin, checking nothing further", () => {
    const read = diagnoseLookup(origin, 200, null);
    expect(read.plugin.result).toBe("fail");
    expect(read.plugin.detail).toContain("/__intervu/session");
    expect(read.guard.result).toBe("skipped");
    expect(read.daemon.result).toBe("skipped");
    expect(read.session.result).toBe("skipped");
  });

  it("fails the guard with the rejection reason a classified 403 carries", () => {
    const read = diagnoseLookup(origin, 403, {
      error: {
        tag: "ForeignOrigin",
        message: "refused",
        reason: "foreign-page-origin",
        pageOrigin: origin,
      },
    });
    expect(read.plugin.result).toBe("pass");
    expect(read.guard.result).toBe("fail");
    expect(read.guard.detail).toContain("foreign-page-origin");
    expect(read.guard.detail).toContain(
      "page origin doesn't match what the dev server trusts",
    );
    expect(read.guard.detail).toContain(origin);
    expect(read.guard.result === "fail" && read.guard.hint).toContain(
      "Behind a reverse proxy",
    );
    expect(read.daemon.result).toBe("skipped");
  });

  it("still fails the guard on an old dev server's unclassified 403", () => {
    const read = diagnoseLookup(origin, 403, {
      error: { tag: "ForeignOrigin", message: "refused" },
    });
    expect(read.guard.result).toBe("fail");
    expect(read.guard.detail).toContain("older intervu");
  });

  it("fails the daemon check when the relay marked it unreachable", () => {
    const read = diagnoseLookup(origin, 200, {
      session: null,
      daemon: "unreachable",
      ports: [51789],
    });
    expect(read.guard.result).toBe("pass");
    expect(read.daemon.result).toBe("fail");
    expect(read.daemon.detail).toContain("51789");
    expect(read.session.result).toBe("skipped");
  });

  it("passes everything when the origin's Session is open", () => {
    const read = diagnoseLookup(origin, 200, {
      session: { key: "0123456789abcdef", status: "open" },
    });
    expect(read.plugin.result).toBe("pass");
    expect(read.guard.result).toBe("pass");
    expect(read.daemon.result).toBe("pass");
    expect(read.session.result).toBe("pass");
    expect(read.session.detail).toContain("0123456789abcdef");
  });

  it("fails the Session check for none and for ended, with the reopen hint", () => {
    const none = diagnoseLookup(origin, 200, { session: null });
    expect(none.daemon.result).toBe("pass");
    expect(none.session.result).toBe("fail");
    expect(none.session.result === "fail" && none.session.hint).toContain(
      `intervu ${origin}`,
    );

    const ended = diagnoseLookup(origin, 200, {
      session: { key: "0123456789abcdef", status: "ended" },
    });
    expect(ended.session.result).toBe("fail");
    expect(ended.session.detail).toContain("ended");
  });

  it("fails the guard on any other status the overlay cannot read", () => {
    const read = diagnoseLookup(origin, 500, { error: null });
    expect(read.plugin.result).toBe("pass");
    expect(read.guard.result).toBe("fail");
    expect(read.guard.detail).toContain("500");
  });
});

describe("failedCount", () => {
  it("counts failing checks only, never skipped ones", () => {
    const read = diagnoseLookup(origin, 200, null);
    expect(
      failedCount({
        app: { result: "pass", detail: "answered" },
        ...read,
      }),
    ).toBe(1);
  });
});
