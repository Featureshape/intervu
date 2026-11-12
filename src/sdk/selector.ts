import { attr, finder } from "@medv/finder";
import { sourceAttribute } from "../vite/jsxSource.ts";

/**
 * Attributes whose values carry page content rather than structure - the
 * same set redaction masks in snapshots. A selector built on one would leak
 * what redaction masks (the selector itself is never masked) and could not
 * resolve against a masked snapshot, so they never enter a selector.
 */
const contentAttributes = new Set([
  "value",
  "placeholder",
  "alt",
  "title",
  "aria-label",
]);

/**
 * The `@medv/finder` wrapper: a stable, unique CSS selector for an element
 * (issue #5). Selector generation - uniqueness, anchor preference, escaping - is
 * a solved problem we delegate, so this is the only file that touches finder and
 * the unit tests never re-test it. finder throws when it cannot produce a
 * selector (e.g. a detached node); we fall back to the bare tag name rather than
 * propagate, mirroring the chrome controller's graceful-degradation idiom.
 *
 * finder's own attribute filter stays, minus the `intervu/vite` plugin's JSX
 * source stamp and the content-bearing attributes above. The stamp's path-like
 * value fails finder's current word-like check anyway; the explicit exclusions
 * keep both out of selectors whatever finder's defaults become - the stamp
 * exists only in dev and moves with every edit, and content attributes leak
 * what redaction masks.
 */
export const cssSelectorFor = (element: Element): string => {
  try {
    return finder(element, {
      attr: (name, value) =>
        name !== sourceAttribute &&
        !contentAttributes.has(name) &&
        attr(name, value),
    });
  } catch {
    return element.tagName.toLowerCase();
  }
};
