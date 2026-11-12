import { guardRefusalIn, plainWordsOf } from "../vite/guardRefusal.ts";
import {
  openSessionKeyIn,
  unreachedDaemonPortsIn,
} from "../vite/sessionAnswer.ts";

/**
 * Classifying the relay's answer to the overlay's Session lookup, so the
 * dormant badge can tell the truth: a Session is open, no Session is open, no
 * daemon answered the dev server, or the dev server itself refused the page.
 * Pure, so the classification is pinned without a browser.
 */

/** What one Session lookup told the overlay. */
export type LookupState =
  | { readonly kind: "open"; readonly key: string }
  | { readonly kind: "no-session" }
  | { readonly kind: "no-daemon"; readonly ports: readonly number[] }
  | {
      readonly kind: "refused";
      /** The rejection in plain words, ready for the badge's card. */
      readonly reason: string;
      /** The page origin the refused request named, when it named one. */
      readonly pageOrigin: string | undefined;
    };

/**
 * Read a lookup response's `status` and decoded `body` into the state the
 * badge renders. Anything unclassified - an old dev server's bare 403, any
 * other failure - is today's "no Session", so the badge never claims more
 * than it was told.
 */
export const classifyLookup = (status: number, body: unknown): LookupState => {
  if (status === 403) {
    const refusal = guardRefusalIn(body);
    return refusal === null
      ? { kind: "no-session" }
      : {
          kind: "refused",
          reason: plainWordsOf(refusal.reason),
          pageOrigin: refusal.pageOrigin,
        };
  }
  if (status < 200 || status >= 300) {
    return { kind: "no-session" };
  }
  const key = openSessionKeyIn(body);
  if (key !== null) {
    return { kind: "open", key };
  }
  const ports = unreachedDaemonPortsIn(body);
  return ports === null ? { kind: "no-session" } : { kind: "no-daemon", ports };
};
