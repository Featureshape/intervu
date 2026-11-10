import { expect, test } from "@playwright/test";
import { noDaemonAppUrl } from "./support.ts";

/**
 * URL mode at rest: the fixture Vite + React app loads the `intervu/vite`
 * plugin, but its daemon port has nothing listening. The in-page overlay shows
 * the dormant badge, its click reveals the command to hand the agent, and the
 * app's console stays clean.
 */

test("with the daemon stopped the app shows the dormant badge and a clean console", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    problems.push(`requestfailed: ${request.url()}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.push(`${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(noDaemonAppUrl);
  await expect(page.locator("#headline")).toHaveText("Fixture app");

  const badge = page.locator("[data-intervu-badge]");
  await expect(badge).toHaveText("intervu: no agent");
  await expect(badge).toHaveAttribute("data-intervu-badge", "dormant");

  const command = page.locator("[data-intervu-command]");
  await expect(command).toBeHidden();
  await badge.click();
  await expect(badge).toHaveAttribute("aria-expanded", "true");
  await expect(command).toBeVisible();
  await expect(command).toHaveText(`intervu ${noDaemonAppUrl}`);

  // The badge closes again, and the app underneath keeps behaving natively.
  await badge.click();
  await expect(command).toBeHidden();
  await page.locator("#counter").click();
  await expect(page.locator("#counter")).toHaveText("Clicked 1 times");

  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});

test("the overlay lives in its own shadow root, outside the app's DOM", async ({
  page,
}) => {
  await page.goto(noDaemonAppUrl);
  await expect(page.locator("[data-intervu-badge]")).toBeVisible();
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
