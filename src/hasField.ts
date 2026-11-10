/**
 * Narrowing an `unknown` decoded from JSON or storage, shared by the browser
 * modules that read the daemon's answers and the tab's storage without
 * Effect's `Schema`. This module imports nothing, so the overlay's browser
 * bundle can take it in.
 */

/** Whether `value` is an object carrying `name`, narrowing it for reading. */
export const hasField = <K extends string>(
  value: unknown,
  name: K,
): value is Record<K, unknown> =>
  typeof value === "object" && value !== null && name in value;
