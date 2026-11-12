import { hasField } from "../hasField.ts";

/**
 * The relay guard's refusal, as the 403 body carries it: the rejection code
 * and the origins the refused request itself presented - never the server's
 * trusted-host list, which a genuinely foreign page must not learn. Shared by
 * the relay that writes the body and the in-page overlay that renders it, so
 * this module imports only dependency-free modules.
 */

/** Why the guard turned a request away. */
export type GuardRejection =
  | "foreign-host"
  | "foreign-origin"
  | "foreign-page-origin"
  | "cross-site-fetch";

/** Each rejection in plain words, for the badge's card. */
export const rejectionInPlainWords: Record<GuardRejection, string> = {
  "foreign-host":
    "the address the browser used isn't one the dev server trusts",
  "cross-site-fetch":
    "the browser marked the request as sent from another site",
  "foreign-origin":
    "the request's origin doesn't match what the dev server trusts",
  "foreign-page-origin": "page origin doesn't match what the dev server trusts",
};

/**
 * The rejection code `reason` in plain words, or the code itself when it is
 * one this overlay does not know (a newer dev server).
 */
export const plainWordsOf = (reason: string): string => {
  for (const [rejection, words] of Object.entries(rejectionInPlainWords)) {
    if (rejection === reason) {
      return words;
    }
  }
  return reason;
};

/** What a refused request presented, read back from the 403 body. */
export interface GuardRefusal {
  /** The rejection code, `GuardRejection` on a current dev server. */
  readonly reason: string;
  /** The `Origin` header the refused request carried, when it carried one. */
  readonly origin: string | undefined;
  /** The page origin the refused request named, when it named one. */
  readonly pageOrigin: string | undefined;
}

/** A string field of `value`, or `undefined` when it is absent or not one. */
const stringFieldOf = (value: unknown, name: string): string | undefined =>
  hasField(value, name) && typeof value[name] === "string"
    ? value[name]
    : undefined;

/**
 * The refusal a decoded 403 body carries, or `null` when it carries none - an
 * old dev server's unclassified 403, which the overlay renders as today's
 * "no agent".
 */
export const guardRefusalIn = (body: unknown): GuardRefusal | null => {
  const error = hasField(body, "error") ? body.error : null;
  const reason = stringFieldOf(error, "reason");
  return reason === undefined
    ? null
    : {
        reason,
        origin: stringFieldOf(error, "origin"),
        pageOrigin: stringFieldOf(error, "pageOrigin"),
      };
};
