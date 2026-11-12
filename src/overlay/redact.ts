/**
 * Owner-configured redaction (spec review-loop-operability): masking happens
 * in the browser, before anything leaves the page, so unmasked PII never
 * transits. Per-character replacement keeps length, whitespace and DOM
 * structure, so layout, truncation and selector context stay reviewable.
 * Tags, ids, classes, selectors and `data-intervu-src` are never touched, so
 * annotations still resolve and source mapping still works. Pure DOM work,
 * pinned under happy-dom.
 */

/** The attribute an app owner puts on markup that must always be masked. */
export const redactAttribute = "data-intervu-redact";

/** The attributes whose values can carry personal data and get masked. */
const maskedAttributes = [
  "value",
  "placeholder",
  "alt",
  "title",
  "aria-label",
] as const;

/**
 * Mask `text` per character: letters to `x`, digits to `0`. Whitespace,
 * punctuation and length survive, so shape stays while content goes.
 */
export const maskText = (text: string): string =>
  text.replace(/\p{L}/gu, "x").replace(/\p{Nd}/gu, "0");

/** Whether `element` sits under (or carries) the always-on redact marker. */
const underRedactMarker = (element: Element): boolean =>
  element.closest(`[${redactAttribute}]`) !== null;

/** Mask every text node under `element`, itself included. */
const maskTextNodes = (element: Element): void => {
  for (const node of element.childNodes) {
    if (node.nodeType === 3 && node.nodeValue !== null) {
      node.nodeValue = maskText(node.nodeValue);
    } else if (node.nodeType === 1 && node instanceof Element) {
      maskTextNodes(node);
    }
  }
};

/** Mask the sensitive attributes of `element`, itself included. */
const maskAttributes = (element: Element): void => {
  for (const target of [element, ...element.querySelectorAll("*")]) {
    for (const name of maskedAttributes) {
      const value = target.getAttribute(name);
      if (value !== null) {
        target.setAttribute(name, maskText(value));
      }
    }
  }
};

/**
 * Mask `root` in place: with `fullPage` (the owner's `intervu({ redact:
 * true })`), every text node and sensitive attribute under it; without it,
 * only the subtrees under a `data-intervu-redact` marker, which masks
 * regardless of configuration.
 */
export const redactSnapshot = (root: Element, fullPage: boolean): void => {
  const targets = fullPage
    ? [root]
    : [...root.querySelectorAll(`[${redactAttribute}]`)];
  for (const target of targets) {
    maskTextNodes(target);
    maskAttributes(target);
  }
};

/**
 * Mask an annotation's captured strings - its element text and any selected
 * text - when the page is fully redacted or the annotated element sits under
 * the redact marker. The selector and tag stay as they are, so the
 * annotation still resolves against the (equally masked) snapshot.
 */
export const redactCapturedText = (
  element: Element | null,
  fullPage: boolean,
): boolean => fullPage || (element !== null && underRedactMarker(element));
