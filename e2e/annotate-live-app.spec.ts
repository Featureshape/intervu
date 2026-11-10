import * as fs from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { JsonValue } from "@toon-format/toon";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { fixtureAppDir, fixtureAppUrl } from "./support.ts";

/**
 * Annotating the live app (behaviours 13 to 17): with Annotate off the app
 * behaves natively; armed, a click becomes an annotation instead of driving the
 * app. A sent annotation reaches `poll <url>` carrying the JSX `file:line:col`
 * of the element the app's own code rendered, and the page it was made on; a
 * click inside a third-party component reports the nearest app-code element.
 * Selectors and the DOM snapshot carry nothing of intervu's, and annotations
 * from different routes of the app share the origin's one Session.
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

/** Poll the fixture app's Session the way the agent does; its Feedback. */
const pollFeedback = async (): Promise<readonly JsonValue[]> => {
  const run = await runCli(
    ["poll", fixtureAppUrl, "--timeout", "5"],
    browserRecorder(),
  );
  expect(run.exitCode).toBe(0);
  const feedback = fieldOf(run.output, "feedback");
  return Array.isArray(feedback) ? feedback : [];
};

/** Poll the fixture app's Session for the one Feedback sent to it. */
const pollAnnotations = async (): Promise<JsonValue> => {
  const feedback = await pollFeedback();
  expect(feedback).toHaveLength(1);
  return feedback[0] ?? null;
};

/** The `name` field of a polled Feedback or annotation, which must be a string. */
const stringField = (value: JsonValue | undefined, name: string): string => {
  const field = value === undefined ? undefined : fieldOf(value, name);
  expect(typeof field, `expected a string ${name}`).toBe("string");
  return typeof field === "string" ? field : "";
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

test("selectors and the DOM snapshot carry nothing of intervu's", async ({
  page,
}) => {
  await openFreshSession();
  await loadPanel(page, `${fixtureAppUrl}/about`);
  // The paragraph and its ancestors carry the source stamp, and intervu's own
  // markup is in the live document while the Feedback is sent.
  const paragraph = page.getByText("About the fixture app.");
  await expect(paragraph).toHaveAttribute("data-intervu-src", /App\.tsx/);

  await setAnnotate(page, true);
  await paragraph.click();
  await expect(pendingRows(page)).toHaveCount(1);
  await expect(page.locator("intervu-overlay")).toHaveCount(1);
  await send(page, "Tighten the about copy");

  const feedback = await pollAnnotations();
  expect(feedback).toMatchObject({
    annotations: [{ tag: "p", text: "About the fixture app." }],
  });
  const annotations = fieldOf(feedback, "annotations");
  const selector = stringField(
    Array.isArray(annotations) ? annotations[0] : undefined,
    "selector",
  );
  expect(selector).not.toContain("data-intervu-src");
  // It resolves in the app's own document; Playwright's locators would also
  // pierce the panel's shadow root, which a selector never reaches.
  expect(
    await page.evaluate(
      (css) =>
        [...document.querySelectorAll(css)].map(
          (element) => element.textContent,
        ),
      selector,
    ),
  ).toEqual(["About the fixture app."]);

  const snapshot = fs.readFileSync(
    stringField(feedback, "domSnapshotPath"),
    "utf8",
  );
  expect(snapshot).toContain("About the fixture app.");
  expect(snapshot).not.toContain("intervu-overlay");
  expect(snapshot).not.toContain("data-intervu-own");
  expect(snapshot).not.toContain("/__intervu/");
});

test("annotations from two routes land in the origin's one Session", async ({
  page,
}) => {
  await openFreshSession();
  await loadPanel(page, fixtureAppUrl);

  // One Feedback across a client-side route change, each with its own page.
  await setAnnotate(page, true);
  await page.locator("#headline").click();
  await setAnnotate(page, false);
  await page.locator("#nav-about").click();
  await expect(page).toHaveURL(`${fixtureAppUrl}/about`);
  await setAnnotate(page, true);
  await page.getByText("About the fixture app.").click();
  await expect(pendingRows(page)).toHaveCount(2);
  await send(page, "Across two routes");

  // A second Feedback after a full load of a third route.
  const settingsUrl = `${fixtureAppUrl}/settings`;
  await loadPanel(page, settingsUrl);
  await setAnnotate(page, true);
  await page.locator("#counter").click();
  await expect(pendingRows(page)).toHaveCount(1);
  await send(page, "From settings");

  expect(await pollFeedback()).toMatchObject([
    {
      message: "Across two routes",
      annotations: [
        { n: 1, tag: "h1", pageUrl: `${fixtureAppUrl}/` },
        { n: 2, tag: "p", pageUrl: `${fixtureAppUrl}/about` },
      ],
    },
    {
      message: "From settings",
      annotations: [{ n: 1, tag: "button", pageUrl: settingsUrl }],
    },
  ]);
});
