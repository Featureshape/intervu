import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserRecorder, runCli } from "./cli.ts";
import { fixtureAppUrl } from "./support.ts";

/**
 * Behaviour 13 of the live-app-review spec: "In annotate-mode, clicking an
 * element in the app creates an annotation instead of triggering the app's
 * handler". Many apps act on the press of a click rather than on `click`
 * itself - menus and popovers open on `pointerdown`, drag handles start on
 * `mousedown`, some buttons act on `mouseup`. An armed click must reach none of
 * those handlers, only intervu.
 */

const panel = (page: Page): Locator => page.locator("[data-intervu-panel]");
const annotate = (page: Page): Locator =>
  page.locator("[data-intervu-annotate]");
const pendingRows = (page: Page): Locator =>
  page.locator("[data-intervu-pending-id]");

test("armed, a click reaches none of the app's press handlers", async ({
  page,
}) => {
  const opened = await runCli([fixtureAppUrl], browserRecorder());
  expect(opened.exitCode).toBe(0);

  await page.goto(fixtureAppUrl);
  await expect(panel(page)).toBeVisible();

  // The app's own handlers for each phase of a press on the headline, the way
  // a menu trigger or a drag handle registers them.
  await page.evaluate(() => {
    const headline = document.getElementById("headline");
    const seen: string[] = [];
    Reflect.set(window, "__pressHandlersRan", seen);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      headline?.addEventListener(type, () => seen.push(type));
    }
  });

  await annotate(page).click();
  await expect(annotate(page)).toHaveAttribute("aria-pressed", "true");
  const before = await pendingRows(page).count();

  await page.locator("#headline").click();
  await expect(pendingRows(page)).toHaveCount(before + 1);

  const ran = await page.evaluate(() =>
    Reflect.get(window, "__pressHandlersRan"),
  );
  expect(ran).toEqual([]);
});
