/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "@effect/vitest";
import { trimSnapshot } from "../../src/overlay/snapshot.ts";

/**
 * The URL-mode DOM snapshot keeps the markup an agent reads and drops the
 * bulk that only makes the Feedback request too big for a proxy: scripts,
 * style sheets, inline SVG paths and inlined `data:` payloads.
 */

const trimmed = (html: string): string => {
  const root = document.createElement("div");
  root.innerHTML = html;
  trimSnapshot(root);
  return root.innerHTML;
};

describe("trimSnapshot", () => {
  it("drops scripts, style sheets and noscript fallbacks", () => {
    expect(
      trimmed(
        '<script>window.x = 1</script><style>.a{}</style><noscript><p>js off</p></noscript><p class="a">kept</p>',
      ),
    ).toBe('<p class="a">kept</p>');
  });

  it("empties inline SVG but keeps the element and its attributes", () => {
    expect(
      trimmed(
        '<button><svg width="16" aria-label="close"><path d="M0 0L16 16"></path></svg>Close</button>',
      ),
    ).toBe('<button><svg width="16" aria-label="close"></svg>Close</button>');
  });

  it("cuts data: URIs down to their media type", () => {
    expect(
      trimmed(
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo"><a href="/x">x</a>',
      ),
    ).toBe(
      '<img src="data:image/png;base64,..." alt="logo"><a href="/x">x</a>',
    );
    expect(
      trimmed(
        `<div style="background: url(&quot;data:image/svg+xml;utf8,%3Csvg%3E&quot;) no-repeat"></div>`,
      ),
    ).toBe(
      '<div style="background: url(&quot;data:image/svg+xml;utf8,...&quot;) no-repeat"></div>',
    );
    expect(
      trimmed('<img srcset="data:image/png;base64,AAAA 1x, /b.png 2x" alt="">'),
    ).toBe('<img srcset="data:image/png;base64,... 1x, /b.png 2x" alt="">');
  });
});
