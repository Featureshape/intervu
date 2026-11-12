import * as net from "node:net";
import { Effect, Option } from "effect";

/**
 * Picking the daemon's port in the fixed coexistence range: the first one
 * that binds. A bind-and-release probe has a window before the real bind,
 * but the loser of that race fails its own bind loudly at startup rather
 * than silently sharing - acceptable for a loopback dev tool.
 */

/** Whether `port` can be bound on `hostname` right now. */
const isFree = (hostname: string, port: number): Effect.Effect<boolean> =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(port, hostname, () => {
          probe.close(() => resolve(true));
        });
      }),
  );

/** The first bindable port of `ports`, or `None` when every one is taken. */
export const firstFreePort = (
  hostname: string,
  ports: readonly number[],
): Effect.Effect<Option.Option<number>> =>
  Effect.gen(function* () {
    for (const port of ports) {
      if (yield* isFree(hostname, port)) {
        return Option.some(port);
      }
    }
    return Option.none<number>();
  });
