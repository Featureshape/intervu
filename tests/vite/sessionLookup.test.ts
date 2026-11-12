import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  answerSessionLookup,
  relayToOwnSession,
} from "../../src/vite/relay.ts";

/**
 * The relay's Session lookup against a stub daemon: whatever the daemon does -
 * answers, fails, hangs or is not there - the page gets a `200` it can read,
 * so the dormant badge's polling never prints an error in the app's console.
 * The same lookup gates the Session-scoped routes: the relay forwards one only
 * for the Session open for the page's own origin.
 */

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

/** A port nothing listens on: bound once, then released. */
const closedPort = async (): Promise<number> => {
  const port = await listen(() => {});
  const server = servers.pop();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  return port;
};

/** Ask a relay wired to `daemonPort` for `origin`'s Session. */
const lookup = async (
  daemonPort: number,
  origin = "http://localhost:5173",
): Promise<{ status: number; body: unknown }> => {
  const relayPort = await listen((_request, response) =>
    answerSessionLookup(response, daemonPort, origin),
  );
  const response = await fetch(`http://127.0.0.1:${relayPort}/`);
  return { status: response.status, body: await response.json() };
};

describe("answerSessionLookup", () => {
  it("passes the daemon's answer through, asking for the page's origin", async () => {
    const asked: string[] = [];
    const daemonPort = await listen((request, response) => {
      asked.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          session: { key: "0123456789abcdef", status: "open" },
        }),
      );
    });
    expect(await lookup(daemonPort, "http://localhost:5173")).toEqual({
      status: 200,
      body: { session: { key: "0123456789abcdef", status: "open" } },
    });
    expect(asked).toEqual([
      "/apps/session?origin=http%3A%2F%2Flocalhost%3A5173",
    ]);
  });

  it("marks the daemon unreachable when it fails, naming the port", async () => {
    const daemonPort = await listen((_request, response) => {
      response.writeHead(500);
      response.end();
    });
    expect(await lookup(daemonPort)).toEqual({
      status: 200,
      body: { session: null, daemon: "unreachable", ports: [daemonPort] },
    });
  });

  it("marks the daemon unreachable when no daemon listens", async () => {
    const daemonPort = await closedPort();
    expect(await lookup(daemonPort)).toEqual({
      status: 200,
      body: { session: null, daemon: "unreachable", ports: [daemonPort] },
    });
  });

  it("marks the daemon unreachable when it does not answer in time", async () => {
    const daemonPort = await listen(() => {});
    expect(await lookup(daemonPort)).toEqual({
      status: 200,
      body: { session: null, daemon: "unreachable", ports: [daemonPort] },
    });
  });
});

/**
 * A stub daemon whose `GET /apps/session` answers `session`, and which echoes
 * any other request's method, path and body as JSON.
 */
const sessionDaemon = (session: unknown): Promise<number> =>
  listen((request, response) => {
    if (request.url?.startsWith("/apps/session") === true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ session }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });

/** What the relay under test logged, one entry per warning. */
const warnings: string[] = [];

afterEach(() => {
  warnings.length = 0;
});

/** POST `body` through a relay wired to `daemonPort` as `key`'s feedback. */
const postFeedback = async (
  daemonPort: number,
  key: string,
): Promise<{ status: number; body: unknown }> => {
  const path = `/s/${key}/feedback`;
  const relayPort = await listen((request, response) =>
    relayToOwnSession(
      request,
      response,
      daemonPort,
      "http://localhost:5173",
      key,
      path,
      (message) => warnings.push(message),
    ),
  );
  const response = await fetch(`http://127.0.0.1:${relayPort}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"message":"hi"}',
  });
  return { status: response.status, body: await response.json() };
};

const ownKey = "0123456789abcdef";

describe("relayToOwnSession", () => {
  it("forwards a request, body and all, for the origin's open Session", async () => {
    const daemonPort = await sessionDaemon({ key: ownKey, status: "open" });
    expect(await postFeedback(daemonPort, ownKey)).toEqual({
      status: 200,
      body: {
        method: "POST",
        path: `/s/${ownKey}/feedback`,
        body: '{"message":"hi"}',
      },
    });
    expect(warnings).toEqual([]);
  });

  it("refuses another Session's key, and says so in the log", async () => {
    const daemonPort = await sessionDaemon({ key: ownKey, status: "open" });
    expect(await postFeedback(daemonPort, "fedcba9876543210")).toMatchObject({
      status: 404,
      body: { error: { tag: "RouteNotRelayed" } },
    });
    expect(warnings).toEqual([
      "[intervu] refused POST /__intervu/s/fedcba9876543210/feedback: Session fedcba9876543210 is not the Session open for the page origin http://localhost:5173",
    ]);
  });

  it("refuses the origin's Session once it has ended", async () => {
    const daemonPort = await sessionDaemon({ key: ownKey, status: "ended" });
    expect(await postFeedback(daemonPort, ownKey)).toMatchObject({
      status: 404,
      body: { error: { tag: "RouteNotRelayed" } },
    });
  });

  it("refuses when no daemon listens", async () => {
    expect(await postFeedback(await closedPort(), ownKey)).toMatchObject({
      status: 404,
      body: { error: { tag: "RouteNotRelayed" } },
    });
  });
});
