import { type ChildProcess, spawn } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { browserRecorder, runCli } from "./cli.ts";
import { daemonPort, fixtureAppDir, viteBin } from "./support.ts";

/**
 * Behaviour 8: running `intervu <url>` again on the same origin resumes the
 * same Session. No tab is opened by default, so the human sees the resumed
 * Session only in the tab they already have open - which must leave the ended
 * state and take feedback again, without a reload, the way it swaps the
 * dormant badge for the panel (behaviour 4).
 *
 * The spec serves the fixture app on its own port, so ending this origin's
 * Session never races another spec's.
 */

const appPort = 52011;
const appUrl = `http://localhost:${appPort}`;

let devServer: ChildProcess | undefined;

const appAnswers = (): Promise<boolean> =>
  fetch(appUrl)
    .then((response) => response.ok)
    .catch(() => false);

test.beforeAll(async () => {
  test.setTimeout(90_000);
  devServer = spawn(
    "node",
    [viteBin, "--port", String(appPort), "--strictPort"],
    {
      cwd: fixtureAppDir,
      env: {
        ...process.env,
        INTERVU_PORT: String(daemonPort),
        FIXTURE_APP_PORT: String(appPort),
      },
      stdio: "ignore",
    },
  );
  await expect.poll(appAnswers, { timeout: 60_000 }).toBe(true);
});

test.afterAll(() => {
  devServer?.kill();
});

const endedPill = (page: Page) => page.locator("[data-intervu-ended-pill]");

test("intervu <url> after intervu end <url> brings the open tab's panel back to a live review", async ({
  page,
}) => {
  const browser = browserRecorder();
  await runCli(["end", appUrl], browser);
  const opened = await runCli([appUrl], browser);
  expect(opened.exitCode).toBe(0);

  await page.goto(appUrl);
  await expect(page.locator("[data-intervu-panel]")).toBeVisible();

  const ended = await runCli(["end", appUrl], browser);
  expect(ended.exitCode).toBe(0);
  await expect(endedPill(page)).toBeVisible();

  const resumed = await runCli([`${appUrl}/about`], browser);
  expect(resumed.exitCode).toBe(0);
  expect(browser.opened()).toEqual([]);

  // Within 2 seconds, with no reload, the open tab shows the resumed review.
  await expect(endedPill(page)).toBeHidden({ timeout: 2_000 });
  await expect(page.locator("[data-intervu-composer]")).toBeVisible();

  const message = `after resume ${Date.now()}`;
  await page.locator("[data-intervu-composer-input]").fill(message);
  await page.locator("[data-intervu-send]").click();
  const polled = await runCli(["poll", appUrl, "--timeout", "5"], browser);
  expect(polled.stdout).toContain(message);
});
