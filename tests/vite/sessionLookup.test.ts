import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { answerSessionLookup } from "../../src/vite/relay.ts";

/**
 * The relay's Session lookup against a stub daemon: whatever the daemon does -
 * answers, fails, hangs or is not there - the page gets a `200` it can read,
 * so the dormant badge's polling never prints an error in the app's console.
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

  it("answers no Session when the daemon fails", async () => {
    const daemonPort = await listen((_request, response) => {
      response.writeHead(500);
      response.end();
    });
    expect(await lookup(daemonPort)).toEqual({
      status: 200,
      body: { session: null },
    });
  });

  it("answers no Session when no daemon listens", async () => {
    expect(await lookup(await closedPort())).toEqual({
      status: 200,
      body: { session: null },
    });
  });

  it("answers no Session when the daemon does not answer in time", async () => {
    const daemonPort = await listen(() => {});
    expect(await lookup(daemonPort)).toEqual({
      status: 200,
      body: { session: null },
    });
  });
});
