import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { pluginReportPath } from "../../src/DaemonRoutes.ts";
import {
  activeWithin,
  createReporterState,
  recordRefusal,
  recordSeen,
  reportBodyOf,
  sendPluginReport,
} from "../../src/vite/reporter.ts";

/**
 * The plugin-report core, pinned without a dev server: what one plugin has
 * seen folds into tallies, the report body carries exactly the daemon's wire
 * shape, the heartbeat predicate only fires while tabs were recently active,
 * and the send is fire-and-forget against daemons that answer, refuse or are
 * not there.
 */

describe("recordSeen", () => {
  it("is newly-seen once per page origin, and bumps activity every time", () => {
    const state = createReporterState();
    expect(recordSeen(state, "http://localhost:5173", 1_000)).toBe(true);
    expect(recordSeen(state, "http://localhost:5173", 2_000)).toBe(false);
    expect(recordSeen(state, "https://app.test", 3_000)).toBe(true);
    expect(state.lastActivityAt).toBe(3_000);
    expect([...state.seenOrigins]).toEqual([
      "http://localhost:5173",
      "https://app.test",
    ]);
  });
});

describe("recordRefusal", () => {
  it("tallies by reason and presented origins, keeping the last time", () => {
    const state = createReporterState();
    const refusal = {
      reason: "foreign-page-origin",
      origin: undefined,
      pageOrigin: "https://app.test",
    };
    recordRefusal(state, refusal, 1_000);
    recordRefusal(state, refusal, 2_500);
    recordRefusal(
      state,
      { reason: "foreign-host", origin: undefined, pageOrigin: undefined },
      3_000,
    );
    expect([...state.refusals.values()]).toEqual([
      { ...refusal, count: 2, lastAt: 2_500 },
      {
        reason: "foreign-host",
        origin: undefined,
        pageOrigin: undefined,
        count: 1,
        lastAt: 3_000,
      },
    ]);
    expect(state.lastActivityAt).toBe(3_000);
  });
});

describe("activeWithin", () => {
  it("fires only while a tab held a relay connection within the window", () => {
    const state = createReporterState();
    expect(activeWithin(state, 60_000, 30_000)).toBe(false);
    recordSeen(state, "http://localhost:5173", 40_000);
    expect(activeWithin(state, 60_000, 30_000)).toBe(true);
    expect(activeWithin(state, 70_001, 30_000)).toBe(false);
  });
});

describe("reportBodyOf", () => {
  it("carries the dev server origin, the seen origins and the tallies", () => {
    const state = createReporterState();
    recordSeen(state, "https://app.test", 1_000);
    recordRefusal(
      state,
      {
        reason: "foreign-page-origin",
        origin: "https://evil.example",
        pageOrigin: "https://app.test:8443",
      },
      2_000,
    );
    expect(JSON.parse(reportBodyOf(state, "http://localhost:5173"))).toEqual({
      origin: "http://localhost:5173",
      seenOrigins: ["https://app.test"],
      refusals: [
        {
          reason: "foreign-page-origin",
          origin: "https://evil.example",
          pageOrigin: "https://app.test:8443",
          count: 1,
          lastAt: 2_000,
        },
      ],
    });
  });

  it("drops the origins a refusal did not present", () => {
    const state = createReporterState();
    recordRefusal(
      state,
      { reason: "foreign-host", origin: undefined, pageOrigin: undefined },
      1_000,
    );
    const body: unknown = JSON.parse(
      reportBodyOf(state, "http://localhost:5173"),
    );
    expect(body).toEqual({
      origin: "http://localhost:5173",
      seenOrigins: [],
      refusals: [{ reason: "foreign-host", count: 1, lastAt: 1_000 }],
    });
  });
});

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** Listen on a free loopback port and return it. */
const listen = (handler: http.RequestListener): Promise<number> =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address: AddressInfo | string | null = server.address();
      resolve(
        typeof address === "object" && address !== null ? address.port : 0,
      );
    });
  });

describe("sendPluginReport", () => {
  it("POSTs the body to the report route on every port given", async () => {
    const taken: { path: string | undefined; body: string }[] = [];
    let reportTaken: () => void = () => {};
    const received = new Promise<void>((resolve) => {
      reportTaken = resolve;
    });
    let pending = 2;
    const daemon: http.RequestListener = (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        taken.push({
          path: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        pending -= 1;
        if (pending === 0) {
          reportTaken();
        }
      });
    };
    const first = await listen(daemon);
    const second = await listen(daemon);
    sendPluginReport([first, second], '{"origin":"http://x"}');
    await received;
    expect(taken).toEqual([
      { path: pluginReportPath, body: '{"origin":"http://x"}' },
      { path: pluginReportPath, body: '{"origin":"http://x"}' },
    ]);
  });

  it("survives a port nothing listens on and an old daemon's 404", async () => {
    const oldDaemon = await listen((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const free = await listen(() => {});
    const gone = servers.pop();
    await new Promise<void>((resolve) => gone?.close(() => resolve()));
    // Neither throws nor rejects; the relay keeps working regardless.
    sendPluginReport([oldDaemon, free], '{"origin":"http://x"}');
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
