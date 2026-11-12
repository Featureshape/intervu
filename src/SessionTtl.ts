import type { Session } from "./Session.ts";

/**
 * The idle TTL arithmetic (spec review-loop-operability): a Session with no
 * activity for the TTL counts as `ended`. The expiry is computed wherever
 * Sessions are read - the offline Home view filters expired Sessions itself
 * and the daemon's sweep merely tidies - so the math lives here, pure.
 */

/** The default TTL: 24 hours. `INTERVU_SESSION_TTL` (seconds) overrides. */
export const defaultSessionTtlSeconds = 24 * 60 * 60;

/** Whether a Session last active at `lastActivityAt` has idled past `ttlMs`. */
export const isExpired = (
  lastActivityAt: number,
  now: number,
  ttlMs: number,
): boolean => now - lastActivityAt > ttlMs;

/** Whether `session` still counts as live at `now`: open and inside the TTL. */
export const countsAsOpen = (
  session: Session,
  now: number,
  ttlMs: number,
): boolean =>
  session.status === "open" && !isExpired(session.lastActivityAt, now, ttlMs);
