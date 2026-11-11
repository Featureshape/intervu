import * as fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import {
  annotate,
  composerInput,
  panel,
  pendingRows,
  sendButton,
} from "./panel.ts";
import { compilerAppUrl, fixtureAppDir } from "./support.ts";

/**
 * With the React Compiler on, its Babel pass rewrites each component before
 * React's JSX transform runs, adding lines of memo-cache code, so the
 * `source` React's own transform reports points past the lines the author
 * wrote. An annotation's `source` must still name the line in `App.tsx` as
 * written, for an element of the app's own and for its call of a third-party
 * component.
 *
 * The specs share the compiler app's Session and drain its queue, so they run
 * in order.
 */

test.describe.configure({ mode: "serial" });

const appSource = `${fixtureAppDir}/src/App.tsx`;

/** The `file:line:col` of the JSX in `App.tsx` that starts with `opening`. */
const jsxLocation = (opening: string): string => {
  const lines = fs.readFileSync(appSource, "utf8").split("\n");
  const line = lines.findIndex((text) => text.includes(opening));
  expect(line, `expected ${opening} in App.tsx`).toBeGreaterThanOrEqual(0);
  return `${appSource}:${line + 1}:${(lines[line] ?? "").indexOf(opening) + 1}`;
};

/** Annotate `selector`, send, and return the `source` the agent receives. */
const sourceOf = async (page: Page, selector: string): Promise<unknown> => {
  await page.goto(compilerAppUrl);
  await expect(panel(page)).toBeVisible();
  await annotate(page).click();
  await page.locator(selector).click();
  await expect(pendingRows(page)).toHaveCount(1);
  await composerInput(page).fill("");
  await sendButton(page).click();
  await expect(pendingRows(page)).toHaveCount(0);

  const run = await runCli(
    ["poll", compilerAppUrl, "--timeout", "5"],
    browserRecorder(),
  );
  expect(run.exitCode).toBe(0);
  const feedback = fieldOf(run.output, "feedback");
  const first = Array.isArray(feedback) ? feedback[0] : undefined;
  const annotations =
    first === undefined || first === null
      ? undefined
      : fieldOf(first, "annotations");
  const annotation = Array.isArray(annotations) ? annotations[0] : undefined;
  return annotation === undefined || annotation === null
    ? undefined
    : fieldOf(annotation, "source");
};

test.beforeAll(async () => {
  const browser = browserRecorder();
  expect((await runCli([compilerAppUrl], browser)).exitCode).toBe(0);
  await runCli(["poll", compilerAppUrl, "--timeout", "1"], browser);
});

test("the compiler leaves an app element's source on the line as written", async ({
  page,
}) => {
  // The compiler really did rewrite the module: its memo cache is there.
  const compiled = await (
    await page.request.get(`${compilerAppUrl}/src/App.tsx`)
  ).text();
  expect(compiled).toContain("compiler-runtime");

  expect(await sourceOf(page, "#headline")).toBe(
    jsxLocation('<h1 id="headline">'),
  );
});

test("the compiler leaves a third-party component's call site on the line as written", async ({
  page,
}) => {
  expect(await sourceOf(page, "#widget-label")).toBe(
    jsxLocation("<FixtureWidget />"),
  );
});
