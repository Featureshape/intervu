/**
 * Reading the daemon's `GET /apps/session` answer, shared by the relay that
 * gates Session-scoped routes on it and the in-page overlay that waits for a
 * Session to open. This module imports only dependency-free modules, so the
 * overlay's browser bundle can take it in.
 */

import { hasField } from "../hasField.ts";

/** The open Session's key in a decoded `GET /apps/session` answer, or `null`. */
export const openSessionKeyIn = (answer: unknown): string | null =>
  hasField(answer, "session") &&
  hasField(answer.session, "key") &&
  hasField(answer.session, "status") &&
  answer.session.status === "open" &&
  typeof answer.session.key === "string"
    ? answer.session.key
    : null;

/** One daemon's decoded lookup answer, tagged with the port it came from. */
export interface DaemonLookupAnswer {
  readonly port: number;
  readonly answer: unknown;
}

/** The open Session in `answer` with its activity stamp, or `null`. */
const openSessionIn = (
  answer: unknown,
): { readonly key: string; readonly lastActivityAt: number } | null => {
  const key = openSessionKeyIn(answer);
  if (key === null) {
    return null;
  }
  const lastActivityAt =
    hasField(answer, "session") &&
    hasField(answer.session, "lastActivityAt") &&
    typeof answer.session.lastActivityAt === "number"
      ? answer.session.lastActivityAt
      : 0;
  return { key, lastActivityAt };
};

/** Which answer the relay forwards when several daemons answered. */
export type LookupChoice =
  | {
      readonly kind: "open";
      readonly port: number;
      readonly key: string;
      /** Every port holding an open Session; more than one earns a warning. */
      readonly openPorts: readonly number[];
      readonly answer: unknown;
    }
  | {
      readonly kind: "none";
      /** The port whose answer is forwarded; `null` with no answers at all. */
      readonly port: number | null;
      readonly answer: unknown;
    };

/**
 * Choose among the daemons that answered a Session lookup: the one holding
 * an open Session for the origin wins, and when two do, the most recently
 * active one (ports in `openPorts` let the relay warn about the tie). With
 * no open Session anywhere, an answer that at least names a Session (an
 * ended one) beats a bare `session: null`.
 */
export const chooseLookupAnswer = (
  answers: readonly DaemonLookupAnswer[],
): LookupChoice => {
  const open = answers.flatMap((entry) => {
    const found = openSessionIn(entry.answer);
    return found === null ? [] : [{ ...entry, found }];
  });
  if (open.length > 0) {
    const freshest = [...open].sort(
      (a, b) => b.found.lastActivityAt - a.found.lastActivityAt,
    );
    const chosen = freshest[0] ?? open[0];
    if (chosen !== undefined) {
      return {
        kind: "open",
        port: chosen.port,
        key: chosen.found.key,
        openPorts: open.map((entry) => entry.port),
        answer: chosen.answer,
      };
    }
  }
  const withSession = answers.find(
    (entry) =>
      hasField(entry.answer, "session") && entry.answer.session !== null,
  );
  const fallback = withSession ?? answers[0];
  return {
    kind: "none",
    port: fallback?.port ?? null,
    answer: fallback?.answer ?? null,
  };
};

/**
 * The daemon port(s) a decoded relay lookup answer says nothing answered on,
 * or `null` when it says no such thing - a daemon's own answer, or a relay
 * from before the `daemon` field, which the overlay reads as today's
 * "no Session".
 */
export const unreachedDaemonPortsIn = (
  answer: unknown,
): readonly number[] | null =>
  hasField(answer, "daemon") &&
  answer.daemon === "unreachable" &&
  hasField(answer, "ports") &&
  Array.isArray(answer.ports)
    ? answer.ports.filter((port): port is number => typeof port === "number")
    : null;
