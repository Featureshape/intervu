/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "@effect/vitest";
import {
  maskText,
  redactCapturedText,
  redactSnapshot,
} from "../../src/overlay/redact.ts";

/**
 * Owner-configured redaction, pinned without a browser: per-character
 * masking keeps length, whitespace and structure; full-page masking touches
 * every text node and sensitive attribute but never tags, ids, classes or
 * `data-intervu-src`; and the `data-intervu-redact` subtree masks even with
 * full-page redaction off.
 */

describe("maskText", () => {
  it("masks letters to x and digits to 0, keeping shape", () => {
    expect(maskText("Ada Lovelace")).toBe("xxx xxxxxxxx");
    expect(maskText("4111 1111 1111 1111")).toBe("0000 0000 0000 0000");
    expect(maskText("a.b@example.com, +48 601-222-333")).toBe(
      "x.x@xxxxxxx.xxx, +00 000-000-000",
    );
    expect(maskText("Zażółć gęślą jaźń 7")).toBe("xxxxxx xxxxx xxxx 0");
    expect(maskText("  \n\t")).toBe("  \n\t");
  });
});

/** A document body built from `html`, redacted with `fullPage`. */
const redacted = (html: string, fullPage: boolean): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  redactSnapshot(root, fullPage);
  return root;
};

describe("redactSnapshot with the owner's redact on", () => {
  it("masks every text node and sensitive attribute, structure intact", () => {
    const root = redacted(
      `<main data-intervu-src="/app/src/App.tsx:4:3">
        <h1 id="headline" class="hero">Fixture app</h1>
        <input value="Ada" placeholder="Full name" aria-label="Name" />
        <img alt="Ada at 42" title="Profile 7" src="/a.png" />
      </main>`,
      true,
    );
    const html = root.innerHTML;
    expect(html).not.toContain("Fixture app");
    expect(html).toContain("xxxxxxx xxx");
    expect(root.querySelector("input")?.getAttribute("value")).toBe("xxx");
    expect(root.querySelector("input")?.getAttribute("placeholder")).toBe(
      "xxxx xxxx",
    );
    expect(root.querySelector("input")?.getAttribute("aria-label")).toBe(
      "xxxx",
    );
    expect(root.querySelector("img")?.getAttribute("alt")).toBe("xxx xx 00");
    expect(root.querySelector("img")?.getAttribute("title")).toBe("xxxxxxx 0");
    // Tags, ids, classes, selectors and the source stamp stay reviewable.
    expect(root.querySelector("#headline")?.className).toBe("hero");
    expect(root.querySelector("main")?.getAttribute("data-intervu-src")).toBe(
      "/app/src/App.tsx:4:3",
    );
    expect(root.querySelector("img")?.getAttribute("src")).toBe("/a.png");
  });
});

describe("redactSnapshot with the owner's redact off", () => {
  it("masks only the data-intervu-redact subtree", () => {
    const root = redacted(
      `<h1 id="headline">Fixture app</h1>
       <section id="customer" data-intervu-redact>
         <p id="name">Ada Lovelace</p>
         <input value="4111 1111 1111 1111" />
       </section>`,
      false,
    );
    const html = root.innerHTML;
    expect(html).toContain("Fixture app");
    expect(html).not.toContain("Ada Lovelace");
    expect(html).toContain("xxx xxxxxxxx");
    expect(root.querySelector("input")?.getAttribute("value")).toBe(
      "0000 0000 0000 0000",
    );
    expect(root.querySelector("#name")).not.toBeNull();
  });

  it("touches nothing without the marker", () => {
    const root = redacted("<p>Ada Lovelace, 4111</p>", false);
    expect(root.innerHTML).toBe("<p>Ada Lovelace, 4111</p>");
  });
});

describe("redactCapturedText", () => {
  it("masks under full-page redaction, under the marker, and nowhere else", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section data-intervu-redact><p id="in">x</p></section><p id="out">y</p>`;
    const inside = root.querySelector("#in");
    const outside = root.querySelector("#out");
    expect(redactCapturedText(outside, true)).toBe(true);
    expect(redactCapturedText(inside, false)).toBe(true);
    expect(redactCapturedText(outside, false)).toBe(false);
    expect(redactCapturedText(null, false)).toBe(false);
  });

  it("masks an anchor that contains the marker: a spanning capture is tainted", () => {
    const root = document.createElement("div");
    root.innerHTML = `<article id="around">before <section data-intervu-redact>secret</section> after</article>`;
    // A text selection spanning the marker anchors on the ancestor around it,
    // and an element annotation's text includes its children's.
    expect(redactCapturedText(root.querySelector("#around"), false)).toBe(true);
  });
});
