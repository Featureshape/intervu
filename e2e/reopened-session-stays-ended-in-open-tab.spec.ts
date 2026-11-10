import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserRecorder, runCli } from "./cli.ts";
import { endableAppUrl } from "./support.ts";

/**
 * Behaviours 4 and 8 of the live-app-review spec: `intervu <url>` resumes the
 * origin's Session, and within 2 seconds the overlay is live in every tab of
 * that origin that is already open, with no page reload ("No tab is opened by
 * default": the overlay appears in the already-open app). A tab that watched the
 * review end must come back to life when the agent re-opens it, or the human
 * cannot send to the review the agent is now polling.
 */

const panel = (page: Page): Locator => page.locator("[data-intervu-panel]");

test("re-opening an ended review revives the panel in the already-open tab", async ({
  page,
}) => {
  const browser = browserRecorder();
  const opened = await runCli([endableAppUrl], browser);
  expect(opened.exitCode).toBe(0);

  await page.goto(endableAppUrl);
  await expect(panel(page)).toBeVisible();
  await expect(page.locator("[data-intervu-annotate]")).toBeEnabled();

  const ended = await runCli(["end", endableAppUrl], browser);
  expect(ended.exitCode).toBe(0);
  await expect(page.locator("[data-intervu-ended-pill]")).toBeVisible();

  const reopened = await runCli([endableAppUrl], browser);
  expect(reopened.exitCode).toBe(0);
  expect(browser.opened()).toEqual([]);

  await expect(page.locator("[data-intervu-ended-pill]")).toBeHidden({
    timeout: 2_000,
  });
  await expect(page.locator("[data-intervu-annotate]")).toBeEnabled({
    timeout: 2_000,
  });
});
