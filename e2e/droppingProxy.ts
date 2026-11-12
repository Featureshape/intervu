import * as net from "node:net";

/**
 * A TCP relay that cuts idle connections, the way an aggressive proxy or NAT
 * in front of a long-poll does after roughly 300s - compressed to a couple
 * of seconds so a spec can watch the poll outlive several cuts. Any
 * connection with no bytes in either direction for `idleMs` is destroyed on
 * both sides; `cuts()` counts how many died that way.
 */

export interface DroppingProxy {
  readonly port: number;
  readonly cuts: () => number;
  readonly close: () => Promise<void>;
}

export const startDroppingProxy = (options: {
  readonly port: number;
  readonly targetPort: number;
  readonly idleMs: number;
}): Promise<DroppingProxy> => {
  let cuts = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const upstream = net.connect(options.targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);

    let idleTimer: NodeJS.Timeout | null = null;
    const cut = (): void => {
      cuts += 1;
      client.destroy();
      upstream.destroy();
    };
    const armIdle = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(cut, options.idleMs);
    };

    client.on("data", armIdle);
    upstream.on("data", armIdle);
    const cleanup = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("close", () => {
      upstream.destroy();
      cleanup();
    });
    upstream.on("close", () => {
      client.destroy();
      cleanup();
    });
    client.on("error", () => client.destroy());
    upstream.on("error", () => upstream.destroy());

    client.pipe(upstream);
    upstream.pipe(client);
    armIdle();
  });

  return new Promise((resolve) => {
    server.listen(options.port, "127.0.0.1", () =>
      resolve({
        port: options.port,
        cuts: () => cuts,
        close: () =>
          new Promise<void>((closed) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => closed());
          }),
      }),
    );
  });
};
