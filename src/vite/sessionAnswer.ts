/**
 * Reading the daemon's `GET /apps/session` answer, shared by the relay that
 * gates Session-scoped routes on it and the in-page overlay that waits for a
 * Session to open. This module imports nothing, so the overlay's browser bundle
 * can take it in.
 */

/** Whether `value` is an object carrying `name`, narrowing it for reading. */
const hasField = <K extends string>(
  value: unknown,
  name: K,
): value is Record<K, unknown> =>
  typeof value === "object" && value !== null && name in value;

/** The open Session's key in a decoded `GET /apps/session` answer, or `null`. */
export const openSessionKeyIn = (answer: unknown): string | null =>
  hasField(answer, "session") &&
  hasField(answer.session, "key") &&
  hasField(answer.session, "status") &&
  answer.session.status === "open" &&
  typeof answer.session.key === "string"
    ? answer.session.key
    : null;
