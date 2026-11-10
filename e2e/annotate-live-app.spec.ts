import * as fs from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { fixtureAppDir, fixtureAppUrl } from "./support.ts";

/**
 * Annotating the live app (behaviours 13, 14, 15): with Annotate off the app
 * behaves natively; armed, a click becomes an annotation instead of driving the
 * app. A sent annotation reaches `poll <url>` carrying the JSX `file:line:col`
 * of the element the app's own code rendered, and the page it was made on; a
 * click inside a third-party component reports the nearest app-code element.
 *
 * The specs share the fixture app's Session and drain its feedback queue, so
 * they run in order.
 */

test.describe.configure({ mode: "serial" });

const appSource = `${fixtureAppDir}/src/App.tsx`;

/**
 * The `file:line:col` of the JSX element whose opening tag starts with
 * `opening` in the fixture's `App.tsx`, with a 1-based column on the `<`, the
 * way React's dev JSX transform reports it.
 */
const jsxLocation = (opening: string): string => {
  const lines = fs.readFileSync(appSource, "utf8").split("\n");
  const line = lines.findIndex((text) => text.includes(opening));
  expect(line, `expected ${opening} in App.tsx`).toBeGreaterThanOrEqual(0);
  return `${appSource}:${line + 1}:${(lines[line] ?? "").indexOf(opening) + 1}`;
};

const panel = (page: Page): Locator => page.locator("[data-intervu-panel]");
const annotate = (page: Page): Locator =>
  page.locator("[data-intervu-annotate]");
const pendingRows = (page: Page): Locator =>
  page.locator("[data-intervu-pending-id]");

/** Open the fixture app's Session and drain anything already queued on it. */
const openFreshSession = async (): Promise<void> => {
  const browser = browserRecorder();
  const opened = await runCli([fixtureAppUrl], browser);
  expect(opened.exitCode).toBe(0);
  const drained = await runCli(
    ["poll", fixtureAppUrl, "--timeout", "1"],
    browser,
  );
  expect(drained.exitCode).toBe(0);
};

/** Load `url` and wait for the panel of the open Session. */
const loadPanel = async (page: Page, url: string): Promise<void> => {
  await page.goto(url);
  await expect(panel(page)).toBeVisible();
};

/** Arm or disarm Annotate-mode from the panel. */
const setAnnotate = async (page: Page, armed: boolean): Promise<void> => {
  if ((await annotate(page).getAttribute("aria-pressed")) !== String(armed)) {
    await annotate(page).click();
  }
  await expect(annotate(page)).toHaveAttribute("aria-pressed", String(armed));
};

/** Send the composer's message and pending annotations, and wait for it. */
const send = async (page: Page, message: string): Promise<void> => {
  await page.locator("[data-intervu-composer-input]").fill(message);
  await page.locator("[data-intervu-send]").click();
  await expect(pendingRows(page)).toHaveCount(0);
};

/** Poll the fixture app's Session the way the agent does. */
const pollAnnotations = async (): Promise<unknown> => {
  const run = await runCli(
    ["poll", fixtureAppUrl, "--timeout", "5"],
    browserRecorder(),
  );
  expect(run.exitCode).toBe(0);
  const feedback = fieldOf(run.output, "feedback");
  expect(Array.isArray(feedback) ? feedback.length : 0).toBe(1);
  return Array.isArray(feedback) ? feedback[0] : null;
};

test("armed, a click annotates instead of running the app's handler", async ({
  page,
}) => {
  await openFreshSession();
  await loadPanel(page, fixtureAppUrl);
  const counter = page.locator("#counter");

  await counter.click();
  await expect(counter).toHaveText("Clicked 1 times");

  await setAnnotate(page, true);
  await counter.click();
  await expect(pendingRows(page)).toHaveCount(1);
  await expect(pendingRows(page)).toContainText("<button>");
  await expect(counter).toHaveText("Clicked 1 times");

  // The panel's own controls stay live while armed, and are never annotated.
  await setAnnotate(page, false);
  await expect(pendingRows(page)).toHaveCount(1);
  await counter.click();
  await expect(counter).toHaveText("Clicked 2 times");
});

test("a sent annotation reaches poll with its JSX source and page URL", async ({
  page,
}) => {
  await openFreshSession();
  const pageUrl = `${fixtureAppUrl}/settings?tab=profile`;
  await loadPanel(page, pageUrl);

  await setAnnotate(page, true);
  await page.locator("#headline").click();
  await expect(pendingRows(page)).toHaveCount(1);
  await send(page, "Make the headline friendlier");

  expect(await pollAnnotations()).toMatchObject({
    message: "Make the headline friendlier",
    annotations: [
      {
        n: 1,
        kind: "element",
        tag: "h1",
        text: "Fixture app",
        source: jsxLocation('<h1 id="headline">'),
        pageUrl,
      },
    ],
  });
});

test("a click inside a third-party component reports the nearest app-code element", async ({
  page,
}) => {
  await openFreshSession();
  await loadPanel(page, fixtureAppUrl);
  // The widget's own elements carry no stamp; the app's wrapper does.
  await expect(page.locator("#widget-label")).not.toHaveAttribute(
    "data-intervu-src",
    /.*/,
  );

  await setAnnotate(page, true);
  await page.locator("#widget-label").click();
  await expect(pendingRows(page)).toHaveCount(1);
  await send(page, "");

  expect(await pollAnnotations()).toMatchObject({
    annotations: [
      {
        tag: "span",
        text: "Third-party widget",
        source: jsxLocation('<section id="widget-slot">'),
        pageUrl: `${fixtureAppUrl}/`,
      },
    ],
  });
});
