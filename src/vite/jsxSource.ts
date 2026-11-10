import type { Plugin } from "vite";

/**
 * The dev-only JSX source stamp of the `intervu/vite` plugin: every intrinsic
 * element (a lowercase tag, never a component) the app's own code renders
 * carries `data-intervu-src="<file>:<line>:<col>"`, so an annotation can name
 * the JSX that rendered the clicked element.
 *
 * The stamp needs no parser of its own. In dev, React's JSX transform (Babel,
 * esbuild, Oxc or SWC, whichever `@vitejs/plugin-react` runs) compiles each
 * element to a `jsxDEV(type, props, key, isStatic, source, self)` call whose
 * `source` is the element's `{fileName, lineNumber, columnNumber}`, with a
 * 1-based column. The plugin resolves the app's `<runtime>/jsx-dev-runtime`
 * import to a wrapper that adds the attribute from that `source`, then calls
 * the real runtime. Imports from `node_modules` keep the real runtime, and a
 * `source` inside `node_modules` is never stamped, so a third-party element
 * leaves the attribute to the nearest one written in the app.
 */

/** The attribute that carries an element's JSX `file:line:col`. */
export const sourceAttribute = "data-intervu-src";

/** The id prefix of the wrapper module, one per wrapped runtime specifier. */
const wrapperPrefix = "\0intervu-jsx-dev-runtime:";

/**
 * `props` with the source stamp added when `type` is an intrinsic element and
 * `source` points into the app's own code; `props` unchanged otherwise.
 *
 * The wrapper module embeds this function's source text, so it must reference
 * nothing outside its own body.
 */
export const stampSource = (
  type: unknown,
  props: unknown,
  source: unknown,
): unknown => {
  if (
    typeof type !== "string" ||
    typeof props !== "object" ||
    props === null ||
    typeof source !== "object" ||
    source === null ||
    !("fileName" in source) ||
    !("lineNumber" in source) ||
    !("columnNumber" in source) ||
    typeof source.fileName !== "string" ||
    /[\\/]node_modules[\\/]/.test(source.fileName)
  ) {
    return props;
  }
  const file = source.fileName.replace(/\?.*$/, "");
  return {
    ...props,
    "data-intervu-src": `${file}:${source.lineNumber}:${source.columnNumber}`,
  };
};

/** Whether `importer` is app code whose JSX should be stamped. */
const isAppModule = (importer: string | undefined): importer is string =>
  importer !== undefined &&
  !importer.startsWith("\0") &&
  !/[\\/]node_modules[\\/]/.test(importer);

/** The wrapper module that stamps sources, then calls `runtime`'s `jsxDEV`. */
export const wrapperModule = (runtime: string): string =>
  [
    `import { Fragment, jsxDEV as runtimeJsxDEV } from ${JSON.stringify(runtime)};`,
    `const stampSource = ${stampSource.toString()};`,
    "export { Fragment };",
    "export const jsxDEV = (type, props, key, isStaticChildren, source, self) =>",
    "  runtimeJsxDEV(type, stampSource(type, props, source), key, isStaticChildren, source, self);",
  ].join("\n");

/**
 * The plugin half that stamps sources. It runs before Vite's own resolver
 * (`enforce: "pre"`) so it sees the bare `react/jsx-dev-runtime` the JSX
 * transform imports, and only on the dev server: a production build never
 * imports the dev runtime, and never sees this plugin.
 */
export const jsxSourcePlugin = (): Plugin => ({
  name: "intervu:jsx-source",
  apply: "serve",
  enforce: "pre",
  resolveId(specifier, importer) {
    return specifier.endsWith("/jsx-dev-runtime") && isAppModule(importer)
      ? `${wrapperPrefix}${specifier}`
      : null;
  },
  load(id) {
    return id.startsWith(wrapperPrefix)
      ? wrapperModule(id.slice(wrapperPrefix.length))
      : null;
  },
});
