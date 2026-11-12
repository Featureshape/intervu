import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * Who this daemon process is, for `/health`: a fresh instance id per process
 * plus the state dir it owns (served by the route from `AppConfig`). "Mine"
 * means "same state dir" - a client that finds a live daemon with another
 * state dir on a port leaves it alone and binds the next port in the range,
 * which is how daemons from different agent sandboxes coexist.
 */
export class DaemonIdentity extends Context.Service<
  DaemonIdentity,
  {
    readonly instanceId: string;
  }
>()("@intervu/DaemonIdentity") {
  static readonly layer = Layer.effect(
    DaemonIdentity,
    Effect.sync(() => ({ instanceId: crypto.randomUUID() })),
  );
}

/**
 * The port this daemon actually bound - the first free one in the range, or
 * the pinned/flagged one. Only the `server` command provides it; `/status`
 * names it, so clients see the real port rather than the configured default.
 */
export class DaemonBoundPort extends Context.Service<
  DaemonBoundPort,
  {
    readonly port: number;
  }
>()("@intervu/DaemonBoundPort") {}
