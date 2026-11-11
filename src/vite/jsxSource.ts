import type { Plugin } from "vite";
import { hasField } from "../hasField.ts";

/**
 * The dev-only JSX source stamp of the `intervu/vite` plugin: every element the
 * app's own code writes is tied to its JSX `file:line:col`, so an annotation
 * can name the code that rendered the clicked element. An intrinsic element (a
 * lowercase tag) carries it as `data-intervu-src`; a component element's call
 * site goes into a registry the overlay reads, so the props a component gets
 * stay exactly the props the app passed.
 *
 * The location comes from the original source. A transform that runs before
 * every other plugin parses each `.jsx` / `.tsx` module of the app and writes
 * `data-intervu-src={"<file>:<line>:<col>"}` into each JSX opening element, so
 * a pass that rewrites the file before React's JSX transform (the React
 * Compiler's Babel pass adds dozens of lines of memo-cache code) cannot shift
 * the line. When that parse is not possible (Vite 7 parses no TypeScript), the
 * `source` argument React's dev JSX transform passes to `jsxDEV` stands in.
 *
 * Both reach React through `jsxDEV`: the plugin resolves the app's
 * `<runtime>/jsx-dev-runtime` import to a wrapper that keeps the attribute on
 * intrinsic elements, takes it off component elements and records it against
 * the element's props, then calls the real runtime. Imports from
 * `node_modules` keep the real runtime and their modules are never stamped, so
 * a third-party element leaves the answer to the nearest element the app wrote.
 */

/** The attribute that carries an element's JSX `file:line:col`. */
export const sourceAttribute = "data-intervu-src";

/**
 * The `Symbol.for` key of the global registry that maps a component element's
 * props object to its JSX call site. A React fiber's `memoizedProps` is that
 * same object, so the overlay can look a fiber up in it.
 */
export const sourceRegistryKey = "intervu.jsxSources";

/** The id prefix of the wrapper module, one per wrapped runtime specifier. */
const wrapperPrefix = "\0intervu-jsx-dev-runtime:";

/**
 * Where one element's JSX location goes: the props to hand React, and the call
 * site to record for a component element (`null` for an intrinsic one, whose
 * props carry it, or when there is none).
 *
 * An element already stamped by the source transform keeps that location; one
 * that is not falls back to `source`, the `{fileName, lineNumber,
 * columnNumber}` React's dev JSX transform passes, unless it points into
 * `node_modules`.
 *
 * The wrapper module embeds this function's source text, so it must reference
 * nothing outside its own body.
 */
export const placeSource = (
  type: unknown,
  props: unknown,
  source: unknown,
): readonly [props: unknown, callSite: string | null] => {
  if (typeof props !== "object" || props === null) {
    return [props, null];
  }
  const attribute = "data-intervu-src";
  const stamped: unknown = Reflect.get(props, attribute);
  const fromSource =
    typeof source === "object" &&
    source !== null &&
    "fileName" in source &&
    "lineNumber" in source &&
    "columnNumber" in source &&
    typeof source.fileName === "string" &&
    !/[\\/]node_modules[\\/]/.test(source.fileName)
      ? `${source.fileName.replace(/\?.*$/, "")}:${source.lineNumber}:${source.columnNumber}`
      : null;
  if (typeof type === "string") {
    return typeof stamped === "string" || fromSource === null
      ? [props, null]
      : [{ ...props, [attribute]: fromSource }, null];
  }
  if (typeof stamped === "string") {
    const rest = { ...props };
    Reflect.deleteProperty(rest, attribute);
    return [rest, stamped];
  }
  return [props, fromSource];
};

/** Whether `importer` is app code whose JSX should be stamped. */
const isAppModule = (importer: string | undefined): importer is string =>
  importer !== undefined &&
  !importer.startsWith("\0") &&
  !/[\\/]node_modules[\\/]/.test(importer);

/**
 * The wrapper module that places sources, calls `runtime`'s `jsxDEV`, and
 * records each component element's call site against the props object React
 * keeps.
 */
export const wrapperModule = (runtime: string): string =>
  [
    `import { Fragment, jsxDEV as runtimeJsxDEV } from ${JSON.stringify(runtime)};`,
    `const placeSource = ${placeSource.toString()};`,
    `const registryKey = Symbol.for(${JSON.stringify(sourceRegistryKey)});`,
    "const callSites = globalThis[registryKey] instanceof WeakMap ? globalThis[registryKey] : (globalThis[registryKey] = new WeakMap());",
    "export { Fragment };",
    "export const jsxDEV = (type, props, key, isStaticChildren, source, self) => {",
    "  const [placed, callSite] = placeSource(type, props, source);",
    "  const element = runtimeJsxDEV(type, placed, key, isStaticChildren, source, self);",
    "  if (callSite !== null && typeof element === 'object' && element !== null && typeof element.props === 'object' && element.props !== null) {",
    "    callSites.set(element.props, callSite);",
    "  }",
    "  return element;",
    "};",
  ].join("\n");

/** One attribute to write into the source, at a UTF-16 offset. */
interface Insertion {
  readonly offset: number;
  readonly text: string;
}

/** The offset each line of `code` starts at, for offset-to-line lookups. */
const lineStartsOf = (code: string): readonly number[] => {
  const starts = [0];
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
};

/** The 0-based line `offset` falls on, by binary search over `lineStarts`. */
const lineOf = (lineStarts: readonly number[], offset: number): number => {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

/** The `end` offset of an AST node, or `null` when `node` is not one. */
const endOf = (node: unknown): number | null =>
  hasField(node, "end") && typeof node.end === "number" ? node.end : null;

/**
 * Every JSX opening element in `program`, as the attribute to write right
 * after its tag name (and type arguments): `data-intervu-src` with the
 * element's `file:line:col`, 1-based like React's own `source`.
 */
export const jsxInsertions = (
  program: unknown,
  code: string,
  file: string,
): readonly Insertion[] => {
  const lineStarts = lineStartsOf(code);
  const insertions: Insertion[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    if (
      hasField(node, "type") &&
      node.type === "JSXOpeningElement" &&
      hasField(node, "start") &&
      typeof node.start === "number" &&
      hasField(node, "name")
    ) {
      const nameEnd = endOf(node.name);
      const typeEnd = hasField(node, "typeArguments")
        ? endOf(node.typeArguments)
        : null;
      const offset = Math.max(nameEnd ?? -1, typeEnd ?? -1);
      if (offset > node.start) {
        const line = lineOf(lineStarts, node.start);
        const column = node.start - (lineStarts[line] ?? 0) + 1;
        insertions.push({
          offset,
          text: ` ${sourceAttribute}={${JSON.stringify(`${file}:${line + 1}:${column}`)}}`,
        });
      }
    }
    for (const value of Object.values(node)) {
      if (typeof value === "object" && value !== null) {
        visit(value);
      }
    }
  };
  visit(program);
  return insertions.sort((a, b) => a.offset - b.offset);
};

const base64Digits =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `value` as a source map Base64 VLQ. */
const vlq = (value: number): string => {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let encoded = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) {
      digit |= 32;
    }
    encoded += base64Digits[digit];
  } while (rest > 0);
  return encoded;
};

/** A source map (v3) for `code` after `insertions`, which add no newlines. */
const insertionMap = (
  code: string,
  file: string,
  insertions: readonly Insertion[],
) => {
  const lineStarts = lineStartsOf(code);
  const byLine = new Map<number, Insertion[]>();
  for (const insertion of insertions) {
    const line = lineOf(lineStarts, insertion.offset);
    byLine.set(line, [...(byLine.get(line) ?? []), insertion]);
  }
  let previousSourceLine = 0;
  let previousSourceColumn = 0;
  const lines = lineStarts.map((start, line) => {
    // Each line maps its start, then the text after each insertion, back to
    // the same original column.
    const points: { generated: number; original: number }[] = [
      { generated: 0, original: 0 },
    ];
    let shift = 0;
    for (const insertion of byLine.get(line) ?? []) {
      shift += insertion.text.length;
      const original = insertion.offset - start;
      points.push({ generated: original + shift, original });
    }
    let previousGenerated = 0;
    return points
      .map(({ generated, original }) => {
        const segment =
          vlq(generated - previousGenerated) +
          vlq(0) +
          vlq(line - previousSourceLine) +
          vlq(original - previousSourceColumn);
        previousGenerated = generated;
        previousSourceLine = line;
        previousSourceColumn = original;
        return segment;
      })
      .join(",");
  });
  return {
    version: 3,
    sources: [file],
    sourcesContent: [code],
    names: [],
    mappings: lines.join(";"),
  };
};

/**
 * `code` with every JSX opening element stamped with its original location,
 * and the source map back to `code`; `null` when there is nothing to stamp.
 */
export const stampJsx = (
  program: unknown,
  code: string,
  file: string,
): {
  readonly code: string;
  readonly map: ReturnType<typeof insertionMap>;
} | null => {
  const insertions = jsxInsertions(program, code, file);
  if (insertions.length === 0) {
    return null;
  }
  let stamped = "";
  let from = 0;
  for (const insertion of insertions) {
    stamped += code.slice(from, insertion.offset) + insertion.text;
    from = insertion.offset;
  }
  stamped += code.slice(from);
  return { code: stamped, map: insertionMap(code, file, insertions) };
};

/** The parser language of an app module's file, or `null` for no JSX. */
const jsxLangOf = (file: string): "jsx" | "tsx" | null =>
  file.endsWith(".tsx") ? "tsx" : file.endsWith(".jsx") ? "jsx" : null;

/**
 * The plugin half that stamps sources. It runs before Vite's own resolver
 * (`enforce: "pre"`) so it sees the bare `react/jsx-dev-runtime` the JSX
 * transform imports, and its transform runs ahead of every other plugin's
 * (`order: "pre"`), so it reads the module as written. Only on the dev server:
 * a production build never imports the dev runtime, and never sees this plugin.
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
  transform: {
    order: "pre",
    handler(code, id) {
      const file = id.replace(/\?.*$/, "");
      const lang = jsxLangOf(file);
      if (lang === null || !isAppModule(id) || !code.includes("<")) {
        return null;
      }
      let program: unknown;
      try {
        program = this.parse(code, { lang });
      } catch {
        // A parser that cannot read this module (Vite 7 parses no
        // TypeScript) leaves it to the `source` React's JSX transform passes.
        return null;
      }
      return stampJsx(program, code, file);
    },
  },
});
