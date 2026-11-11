/**
 * The DOM snapshot URL mode sends with each Feedback, cut down to the markup
 * an agent reads. A live app's document carries a lot the agent has no use for
 * and that only makes the request big enough for a proxy in front of the dev
 * server to refuse: the app's scripts and style sheets (often whole CSS-in-JS
 * bundles), inline SVG paths, and images inlined as `data:` URIs. This module
 * strips those from a copy of the document; it is pure DOM work, so it runs
 * under happy-dom in unit tests.
 */

/** What a `data:` URI is cut down to: its media type, then this marker. */
const elidedData = "...";

/** The attributes whose whole value may be a `data:` URI. */
const uriAttributes = ["src", "href", "poster", "data", "xlink:href"] as const;

/** A `data:` URI cut down to its media type, so the agent still sees a kind. */
const elideDataUri = (uri: string): string => {
  const comma = uri.indexOf(",");
  return `${comma === -1 ? uri.slice(0, 40) : uri.slice(0, comma)},${elidedData}`;
};

/** `url(data:...)` inside a `style` attribute or a `srcset` candidate. */
const inlineDataUri = /data:[^\s"'),]*,[^\s"')]*/g;

/**
 * Strip, in place, what an agent reading `root`'s markup does not need:
 * `<script>`, `<style>` and `<noscript>` elements, the children of each inline
 * `<svg>` (the element itself stays, with its attributes, so the layout still
 * reads), and the payload of every `data:` URI.
 */
export const trimSnapshot = (root: Element): void => {
  for (const element of root.querySelectorAll("script, style, noscript")) {
    element.remove();
  }
  for (const svg of root.querySelectorAll("svg")) {
    svg.replaceChildren();
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const name of uriAttributes) {
      const value = element.getAttribute(name);
      if (value?.trimStart().toLowerCase().startsWith("data:")) {
        element.setAttribute(name, elideDataUri(value.trim()));
      }
    }
    for (const name of ["style", "srcset"] as const) {
      const value = element.getAttribute(name);
      if (value?.includes("data:")) {
        element.setAttribute(name, value.replace(inlineDataUri, elideDataUri));
      }
    }
  }
};
