import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserRecorder, runCli } from "./cli.ts";
import { panelAppUrl } from "./support.ts";

/**
 * URL mode's floating panel (behaviours 4, 11, 12): once `intervu <url>` opens
 * the origin's Session, the overlay in the already-open tab swaps the dormant
 * badge for the panel without a reload; the human can move and collapse it, the
 * app keeps its full viewport width, and no `z-index` in the app paints over it.
 *
 * The specs share one origin's Session, and the first ends it to start from the
 * dormant badge, so they run in order.
 */

test.describe.configure({ mode: "serial" });

const badge = (page: Page): Locator => page.locator("[data-intervu-badge]");
const panel = (page: Page): Locator => page.locator("[data-intervu-panel]");
const handle = (page: Page): Locator =>
  page.locator("[data-intervu-panel-handle]");

/** The app's layout width, which a docked panel would shrink. */
const appWidth = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.clientWidth);

/** A non-null bounding box for `locator`, failing the test if it has none. */
const boxOf = async (
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const box = await locator.boundingBox();
  expect(box, "expected the element to have a bounding box").not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
};

/** Open the panel app's Session through the CLI, the way the agent does. */
const openSession = async (): Promise<void> => {
  const run = await runCli([panelAppUrl], browserRecorder());
  expect(run.exitCode).toBe(0);
};

test("intervu <url> swaps the dormant badge for the panel within 2 seconds, without a reload", async ({
  page,
}) => {
  const browser = browserRecorder();
  // Start from no open Session: a first run has none to end yet.
  await runCli(["end", panelAppUrl], browser);

  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto(panelAppUrl);
  await expect(badge(page)).toHaveAttribute("data-intervu-badge", "dormant");
  // App state and a page-scoped marker that a reload would both wipe.
  await page.locator("#counter").click();
  await expect(page.locator("#counter")).toHaveText("Clicked 1 times");
  await page.evaluate(() => {
    document.documentElement.dataset.loadedOnce = "yes";
  });
  const widthBefore = await appWidth(page);

  const run = await runCli([panelAppUrl], browser);
  expect(run.exitCode).toBe(0);
  await expect(panel(page)).toBeVisible({ timeout: 2_000 });

  await expect(badge(page)).toHaveCount(0);
  await expect(page.locator("#counter")).toHaveText("Clicked 1 times");
  await expect(page.locator("html")).toHaveAttribute("data-loaded-once", "yes");
  expect(await appWidth(page)).toBe(widthBefore);
  expect(browser.opened()).toEqual([]);
  expect(problems).toEqual([]);
});

test("the panel moves by its header and collapses, and the app keeps its width", async ({
  page,
}) => {
  await openSession();
  await page.goto(panelAppUrl);
  await expect(panel(page)).toBeVisible();
  const viewportWidth = page.viewportSize()?.width;
  expect(await appWidth(page)).toBe(viewportWidth);

  // Drag the header up and to the left; the panel follows the pointer.
  const before = await boxOf(panel(page));
  const grip = await boxOf(handle(page));
  const from = { x: grip.x + 40, y: grip.y + grip.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 300, from.y - 200, { steps: 8 });
  await page.mouse.up();
  const moved = await boxOf(panel(page));
  expect(moved.x).toBeCloseTo(before.x - 300, 0);
  expect(moved.y).toBeCloseTo(before.y - 200, 0);

  // Collapse to the header, in place, and expand again.
  const collapse = page.locator("[data-intervu-collapse]");
  const body = page.locator("[data-intervu-panel-body]");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.click();
  await expect(collapse).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeHidden();
  const collapsed = await boxOf(panel(page));
  expect(collapsed.height).toBeLessThan(moved.height);
  expect(collapsed.height).toBeCloseTo(grip.height + 2, 0);
  expect(collapsed.x).toBeCloseTo(moved.x, 0);
  expect(collapsed.y).toBeCloseTo(moved.y, 0);

  await collapse.click();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  expect((await boxOf(panel(page))).height).toBeCloseTo(moved.height, 0);

  expect(await appWidth(page)).toBe(viewportWidth);
});

test("an app layer at the highest z-index stays below the panel", async ({
  page,
}) => {
  await openSession();
  await page.goto(panelAppUrl);
  await expect(panel(page)).toBeVisible();

  // The wall is portalled to the end of <body>, after the overlay's host, at
  // the same maximum z-index: only the top layer keeps the panel above it.
  await page.locator("#raise-wall").click();
  await expect(page.locator("#z-wall")).toBeVisible();

  const box = await boxOf(panel(page));
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(hit).toBe("intervu-overlay");

  // The wall does cover the app everywhere else.
  const elsewhere = await page.evaluate(
    () => document.elementFromPoint(8, 8)?.id,
  );
  expect(elsewhere).toBe("z-wall");

  // And the panel still takes the pointer above it.
  await page.locator("[data-intervu-collapse]").click();
  await expect(page.locator("[data-intervu-collapse]")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
