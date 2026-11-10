import { describe, expect, it } from "@effect/vitest";
import { stampSource, wrapperModule } from "../../src/vite/jsxSource.ts";

/**
 * The JSX source stamp's rules, pinned without a dev server: only intrinsic
 * elements from the app's own code get `data-intervu-src`, as `file:line:col`
 * of the `source` React's dev JSX transform passes to `jsxDEV`.
 */

const source = (fileName: string) => ({
  fileName,
  lineNumber: 12,
  columnNumber: 7,
});

describe("stampSource", () => {
  it("stamps an intrinsic element with its file:line:col", () => {
    expect(
      stampSource("button", { id: "save" }, source("/app/src/App.tsx")),
    ).toEqual({ id: "save", "data-intervu-src": "/app/src/App.tsx:12:7" });
  });

  it("drops a module query from the file name", () => {
    expect(stampSource("p", {}, source("/app/src/App.tsx?v=1a2b"))).toEqual({
      "data-intervu-src": "/app/src/App.tsx:12:7",
    });
  });

  it("leaves a component's props alone", () => {
    const props = { id: "save" };
    const Component = () => null;
    expect(stampSource(Component, props, source("/app/src/App.tsx"))).toBe(
      props,
    );
  });

  it("leaves an element from node_modules alone", () => {
    const props = {};
    expect(
      stampSource("div", props, source("/app/node_modules/lib/index.jsx")),
    ).toBe(props);
    expect(
      stampSource("div", props, source("C:\\app\\node_modules\\lib\\a.jsx")),
    ).toBe(props);
  });

  it("leaves an element without a usable source alone", () => {
    const props = {};
    expect(stampSource("div", props, undefined)).toBe(props);
    expect(stampSource("div", props, { fileName: "/a.tsx" })).toBe(props);
  });
});

/** A module's source as an importable `data:` URL. */
const moduleUrl = (code: string): string =>
  `data:text/javascript,${encodeURIComponent(code)}`;

describe("wrapperModule", () => {
  it("calls the wrapped runtime's jsxDEV with stamped props", async () => {
    // A stand-in runtime that records the props each jsxDEV call receives.
    const runtime = moduleUrl(
      [
        "export const Fragment = 'fragment';",
        "export const calls = [];",
        "export const jsxDEV = (type, props, key) => { calls.push([type, props, key]); return type; };",
      ].join("\n"),
    );
    const wrapper: unknown = await import(moduleUrl(wrapperModule(runtime)));
    const recorded: unknown = await import(runtime);
    const at = { fileName: "/app/src/App.tsx", lineNumber: 3, columnNumber: 5 };

    expect(wrapper).toMatchObject({ Fragment: "fragment" });
    if (
      typeof wrapper === "object" &&
      wrapper !== null &&
      "jsxDEV" in wrapper &&
      typeof wrapper.jsxDEV === "function"
    ) {
      wrapper.jsxDEV("p", { id: "a" }, "k", false, at, undefined);
    }
    expect(recorded).toMatchObject({
      calls: [
        ["p", { id: "a", "data-intervu-src": "/app/src/App.tsx:3:5" }, "k"],
      ],
    });
  });
});
