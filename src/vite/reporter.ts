import * as http from "node:http";
import { pluginReportPath } from "../DaemonRoutes.ts";

/**
 * The plugin-report half of `intervu/vite`: the plugin pushes what it has
 * seen - its dev server's own origin, the page origins whose relay requests
 * passed the guard, and its refusal tallies - to every local daemon over
 * loopback. The plugin always knows where the daemon is; the reverse is not
 * true, so reports flow plugin-to-daemon and the daemon never scrapes.
 *
 * The state and its report body are pure, pinned by unit tests; the timers
 * and the HTTP send live at the edges. Dependency-free, because the plugin is
 * published as plain ESM that Vite runs on Node.
 */

/** One refusal tally, keyed by what the refused request presented. */
interface RefusalTally {
  readonly reason: string;
  readonly origin: string | undefined;
  readonly pageOrigin: string | undefined;
  count: number;
  lastAt: number;
}

/** What one dev server's plugin has seen since it started. */
export interface ReporterState {
  /** Page origins whose guarded relay requests passed, in first-seen order. */
  readonly seenOrigins: Set<string>;
  /** Refusal tallies, keyed by reason and the origins presented. */
  readonly refusals: Map<string, RefusalTally>;
  /** When the relay last served any guarded request, refused or not. */
  lastActivityAt: number;
}

/** A fresh, empty reporter state. */
export const createReporterState = (): ReporterState => ({
  seenOrigins: new Set(),
  refusals: new Map(),
  lastActivityAt: 0,
});

/**
 * Record a guarded request that passed for `pageOrigin` at `now`. Returns
 * whether the origin is newly seen, so the caller can report promptly the
 * first time a page shows up.
 */
export const recordSeen = (
  state: ReporterState,
  pageOrigin: string,
  now: number,
): boolean => {
  state.lastActivityAt = now;
  if (state.seenOrigins.has(pageOrigin)) {
    return false;
  }
  state.seenOrigins.add(pageOrigin);
  return true;
};

/** Record a guarded request the relay refused at `now`, tallying it. */
export const recordRefusal = (
  state: ReporterState,
  refusal: {
    readonly reason: string;
    readonly origin: string | undefined;
    readonly pageOrigin: string | undefined;
  },
  now: number,
): void => {
  state.lastActivityAt = now;
  const key = [refusal.reason, refusal.origin, refusal.pageOrigin].join("\n");
  const tally = state.refusals.get(key);
  if (tally === undefined) {
    state.refusals.set(key, { ...refusal, count: 1, lastAt: now });
  } else {
    tally.count += 1;
    tally.lastAt = now;
  }
};

/**
 * Whether the heartbeat should report at `now`: only while some tab held a
 * relay connection within the last `windowMs`, so a dev server nobody looks
 * at goes quiet instead of pinging the daemon forever.
 */
export const activeWithin = (
  state: ReporterState,
  now: number,
  windowMs: number,
): boolean => now - state.lastActivityAt <= windowMs;

/** The `POST /plugins/report` body for `state`, as the daemon decodes it. */
export const reportBodyOf = (
  state: ReporterState,
  devServerOrigin: string,
): string =>
  JSON.stringify({
    origin: devServerOrigin,
    seenOrigins: [...state.seenOrigins],
    refusals: [...state.refusals.values()].map((tally) => ({
      reason: tally.reason,
      origin: tally.origin,
      pageOrigin: tally.pageOrigin,
      count: tally.count,
      lastAt: tally.lastAt,
    })),
  });

/** How long one report send may take before it is abandoned. */
const sendTimeoutMs = 1_000;

/**
 * Fire `body` at `POST /plugins/report` on every daemon port, one request
 * per port, and forget: a daemon that is down, slow, or too old to know the
 * route (its `404`) changes nothing for the relay, so failures are expected
 * and dropped.
 */
export const sendPluginReport = (
  ports: readonly number[],
  body: string,
): void => {
  for (const port of ports) {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pluginReportPath,
        headers: { "content-type": "application/json" },
        timeout: sendTimeoutMs,
      },
      (response) => response.resume(),
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => {});
    request.end(body);
  }
};
