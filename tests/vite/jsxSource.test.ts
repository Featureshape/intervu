import { describe, expect, it } from "@effect/vitest";
import { parseAst } from "vite";
import {
  jsxInsertions,
  placeSource,
  sourceRegistryKey,
  stampJsx,
  wrapperModule,
} from "../../src/vite/jsxSource.ts";

/**
 * The JSX source stamp's rules, pinned without a dev server: the app's own
 * modules get each JSX opening element's original `file:line:col` written in
 * before any other plugin runs; at runtime intrinsic elements keep it as
 * `data-intervu-src` and component elements hand it to the call-site registry.
 * React's own `source` argument stands in when the module was not stamped.
 */

const source = (fileName: string) => ({
  fileName,
  lineNumber: 12,
  columnNumber: 7,
});

describe("placeSource", () => {
  it("stamps an intrinsic element with its file:line:col", () => {
    expect(
      placeSource("button", { id: "save" }, source("/app/src/App.tsx")),
    ).toEqual([
      { id: "save", "data-intervu-src": "/app/src/App.tsx:12:7" },
      null,
    ]);
  });

  it("drops a module query from the file name", () => {
    expect(placeSource("p", {}, source("/app/src/App.tsx?v=1a2b"))).toEqual([
      { "data-intervu-src": "/app/src/App.tsx:12:7" },
      null,
    ]);
  });

  it("keeps the location the source transform wrote over React's source", () => {
    const props = { "data-intervu-src": "/app/src/App.tsx:3:5" };
    expect(placeSource("p", props, source("/app/src/App.tsx"))).toEqual([
      props,
      null,
    ]);
  });

  it("takes a component's stamp off its props and returns it as the call site", () => {
    const Component = () => null;
    const props = { id: "save", "data-intervu-src": "/app/src/App.tsx:3:5" };
    expect(placeSource(Component, props, source("/app/src/App.tsx"))).toEqual([
      { id: "save" },
      "/app/src/App.tsx:3:5",
    ]);
    // The props the app passed are left as they were.
    expect(props).toHaveProperty("data-intervu-src");
  });

  it("falls back to React's source for an unstamped component's call site", () => {
    const Component = () => null;
    const props = { id: "save" };
    expect(placeSource(Component, props, source("/app/src/App.tsx"))).toEqual([
      props,
      "/app/src/App.tsx:12:7",
    ]);
  });

  it("leaves an element from node_modules alone", () => {
    const props = {};
    expect(
      placeSource("div", props, source("/app/node_modules/lib/index.jsx")),
    ).toEqual([props, null]);
    expect(
      placeSource("div", props, source("C:\\app\\node_modules\\lib\\a.jsx")),
    ).toEqual([props, null]);
  });

  it("leaves an element without a usable source alone", () => {
    const props = {};
    expect(placeSource("div", props, undefined)).toEqual([props, null]);
    expect(placeSource("div", props, { fileName: "/a.tsx" })).toEqual([
      props,
      null,
    ]);
  });
});

/** Stamp `code` as `/app/src/App.tsx`, parsed the way Vite 8 parses it. */
const stamp = (code: string) =>
  stampJsx(parseAst(code, { lang: "tsx" }), code, "/app/src/App.tsx");

describe("stampJsx", () => {
  it("writes each opening element's original location after its tag name", () => {
    const code = [
      "export const App = () => (",
      '  <main id="a">',
      "    <Card<string> title={<b>x</b>} />",
      "    <ui.Button />",
      "    <>text</>",
      "  </main>",
      ");",
    ].join("\n");
    expect(stamp(code)?.code).toBe(
      [
        "export const App = () => (",
        '  <main data-intervu-src={"/app/src/App.tsx:2:3"} id="a">',
        '    <Card<string> data-intervu-src={"/app/src/App.tsx:3:5"} title={<b data-intervu-src={"/app/src/App.tsx:3:26"}>x</b>} />',
        '    <ui.Button data-intervu-src={"/app/src/App.tsx:4:5"} />',
        "    <>text</>",
        "  </main>",
        ");",
      ].join("\n"),
    );
  });

  it("counts columns in UTF-16 code units, like React's own source", () => {
    const code = 'const a = "😀"; const b = <p />;';
    expect(
      jsxInsertions(parseAst(code, { lang: "tsx" }), code, "/f.tsx"),
    ).toEqual([{ offset: 28, text: ' data-intervu-src={"/f.tsx:1:27"}' }]);
  });

  it("is null for a module with no JSX", () => {
    expect(stamp("export const a = 1 < 2;")).toBeNull();
  });

  it("maps each original line and the text after each stamp back to the source", () => {
    expect(stamp("const a = (\n  <p>x</p>\n);")?.map).toEqual({
      version: 3,
      sources: ["/app/src/App.tsx"],
      sourcesContent: ["const a = (\n  <p>x</p>\n);"],
      names: [],
      // Line 2 maps column 0 to 0, then column 4 + the 42-character stamp
      // (46, `8C`) back to column 4 (`I`); line 3 maps back to column 0.
      mappings: "AAAA;AACA,8CAAI;AACJ",
    });
  });
});

/** A module's source as an importable `data:` URL. */
const moduleUrl = (code: string): string =>
  `data:text/javascript,${encodeURIComponent(code)}`;

describe("wrapperModule", () => {
  it("calls the wrapped runtime's jsxDEV with placed props and records call sites", async () => {
    // A stand-in runtime that records the props each jsxDEV call receives.
    const runtime = moduleUrl(
      [
        "export const Fragment = 'fragment';",
        "export const calls = [];",
        "export const jsxDEV = (type, props, key) => { calls.push([type, props, key]); return { type, props }; };",
      ].join("\n"),
    );
    const wrapper: unknown = await import(moduleUrl(wrapperModule(runtime)));
    const recorded: unknown = await import(runtime);
    const at = { fileName: "/app/src/App.tsx", lineNumber: 3, columnNumber: 5 };

    expect(wrapper).toMatchObject({ Fragment: "fragment" });
    const Card = () => null;
    let component: unknown = null;
    if (
      typeof wrapper === "object" &&
      wrapper !== null &&
      "jsxDEV" in wrapper &&
      typeof wrapper.jsxDEV === "function"
    ) {
      wrapper.jsxDEV("p", { id: "a" }, "k", false, at, undefined);
      component = wrapper.jsxDEV(
        Card,
        { "data-intervu-src": "/app/src/App.tsx:9:1" },
        undefined,
        false,
        at,
        undefined,
      );
    }
    expect(recorded).toMatchObject({
      calls: [
        ["p", { id: "a", "data-intervu-src": "/app/src/App.tsx:3:5" }, "k"],
        [Card, {}, undefined],
      ],
    });
    const registry: unknown = Reflect.get(
      globalThis,
      Symbol.for(sourceRegistryKey),
    );
    expect(registry).toBeInstanceOf(WeakMap);
    const props =
      typeof component === "object" &&
      component !== null &&
      "props" in component
        ? component.props
        : null;
    expect(props).toEqual({});
    expect(
      registry instanceof WeakMap && typeof props === "object" && props !== null
        ? registry.get(props)
        : null,
    ).toBe("/app/src/App.tsx:9:1");
  });
});
