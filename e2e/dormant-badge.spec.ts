import { expect, type Page, test } from "@playwright/test";
import { version } from "vite";
import { viteVersionHeaderName } from "./fixtures/app/devServer.ts";
import { badge } from "./panel.ts";
import {
  noDaemonAppUrl,
  previousViteAppUrl,
  recordProblems,
} from "./support.ts";

/**
 * URL mode at rest: the fixture Vite + React app loads the `intervu/vite`
 * plugin, but its daemon port has nothing listening. The in-page overlay shows
 * the dormant badge, its click reveals the command to hand the agent, and the
 * app's console stays clean - on the current Vite major and the one before it.
 */

/** The current Vite major, the one installed at the repo root. */
const currentMajor = Number.parseInt(version, 10);

const viteMajors = [
  { label: "current", major: currentMajor, url: noDaemonAppUrl },
  { label: "previous", major: currentMajor - 1, url: previousViteAppUrl },
];

/**
 * Load the app at `url`, served by Vite `major`, and check the badge, its
 * command and a clean console.
 */
const expectDormantBadge = async (
  page: Page,
  url: string,
  major: number,
): Promise<void> => {
  const problems = recordProblems(page);
  page.on("requestfailed", (request) =>
    problems.push(`requestfailed: ${request.url()}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.push(`${response.status()}: ${response.url()}`);
    }
  });

  const response = await page.goto(url);
  const servedBy = response?.headers()[viteVersionHeaderName] ?? "";
  expect(Number.parseInt(servedBy, 10), `served by Vite ${servedBy}`).toBe(
    major,
  );
  await expect(page.locator("#headline")).toHaveText("Fixture app");

  const dormant = badge(page);
  await expect(dormant).toHaveText("intervu: no agent");
  await expect(dormant).toHaveAttribute("data-intervu-badge", "dormant");

  const command = page.locator("[data-intervu-command]");
  await expect(command).toBeHidden();
  await dormant.click();
  await expect(dormant).toHaveAttribute("aria-expanded", "true");
  await expect(command).toBeVisible();
  await expect(command).toHaveText(`intervu ${url}`);

  // The badge closes again, and the app underneath keeps behaving natively.
  await dormant.click();
  await expect(command).toBeHidden();
  await page.locator("#counter").click();
  await expect(page.locator("#counter")).toHaveText("Clicked 1 times");

  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
};

for (const { label, major, url } of viteMajors) {
  test(`with the daemon stopped the app shows the dormant badge and a clean console (${label} Vite major, ${major})`, async ({
    page,
  }) => {
    await expectDormantBadge(page, url, major);
  });
}

test("the overlay lives in its own shadow root, outside the app's DOM", async ({
  page,
}) => {
  await page.goto(noDaemonAppUrl);
  await expect(badge(page)).toBeVisible();
  const placement = await page.evaluate(() => {
    const host = document.querySelector("intervu-overlay");
    return {
      shadowed: host?.shadowRoot?.querySelector("[data-intervu-badge]") != null,
      inLightDom: document.querySelector("[data-intervu-badge]") !== null,
      inAppRoot: document.querySelector("#root intervu-overlay") !== null,
    };
  });
  expect(placement).toEqual({
    shadowed: true,
    inLightDom: false,
    inAppRoot: false,
  });
});
