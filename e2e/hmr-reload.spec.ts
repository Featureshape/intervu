import * as fs from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserRecorder, runCli } from "./cli.ts";
import {
  annotate,
  bubble,
  collapse,
  composerInput,
  handle,
  panel,
  pendingRows,
  sendButton,
} from "./panel.ts";
import {
  boxOf,
  fixtureAppDir,
  recordProblems,
  reloadAppUrl,
} from "./support.ts";

/**
 * URL mode across the app's own reloads (behaviours 18, 19): when the agent
 * edits a source file, Vite's HMR updates the view under the panel, which keeps
 * its Conversation, its pending annotations and its place. A full page reload
 * brings back the unsent message and the place the panel was dragged to, but
 * not whether it was collapsed.
 *
 * The specs share one origin's Session, so they run in order; the first ends
 * any Session a previous run left and opens a fresh one.
 */

test.describe.configure({ mode: "serial" });

/** The fixture module the HMR spec rewrites, and the copy it starts with. */
const noticeSource = `${fixtureAppDir}/src/Notice.tsx`;
const noticeCopy = "Notice: first draft";

/** The pins the overlay draws on the app for pending annotations. */
const markers = (page: Page): Locator => page.locator(".marker");

/** Drag the panel by its header, by `dx` and `dy`; its box once dropped. */
const dragPanel = async (
  page: Page,
  dx: number,
  dy: number,
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const grip = await boxOf(handle(page));
  const from = { x: grip.x + 40, y: grip.y + grip.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
  return boxOf(panel(page));
};

/** Send `message` from the panel and wait for its bubble. */
const send = async (page: Page, message: string): Promise<void> => {
  await composerInput(page).fill(message);
  await sendButton(page).click();
  await expect(bubble(page, "human", message)).toBeVisible();
};

test("an edit to a source file hot-reloads under the panel, which keeps its Conversation, annotation and place", async ({
  page,
}) => {
  const browser = browserRecorder();
  await runCli(["end", reloadAppUrl], browser);
  const opened = await runCli([reloadAppUrl], browser);
  expect(opened.exitCode).toBe(0);

  const problems = recordProblems(page);
  await page.goto(reloadAppUrl);
  await expect(panel(page)).toBeVisible();
  const notice = page.locator("#notice");
  await expect(notice).toHaveText(noticeCopy);

  // Review state the panel holds: a Conversation, a pending annotation, an
  // unsent message and a place away from its starting corner.
  await send(page, "Tighten the notice copy");
  await annotate(page).click();
  await page.locator("#headline").click();
  await expect(pendingRows(page)).toHaveCount(1);
  await expect(markers(page)).toHaveCount(1);
  await composerInput(page).fill("and the headline too");
  const moved = await dragPanel(page, -300, -200);
  // A page-scoped marker a full reload would wipe.
  await page.evaluate(() => {
    document.documentElement.dataset.loadedOnce = "yes";
  });

  // The agent edits the source; Vite hot-reloads the module in place.
  const edited = "Notice: edited by the agent";
  const original = fs.readFileSync(noticeSource, "utf8");
  expect(original).toContain(noticeCopy);
  try {
    fs.writeFileSync(noticeSource, original.replace(noticeCopy, edited));
    await expect(notice).toHaveText(edited);

    await expect(page.locator("html")).toHaveAttribute(
      "data-loaded-once",
      "yes",
    );
    await expect(bubble(page, "human", "Tighten the notice copy")).toHaveCount(
      1,
    );
    await expect(pendingRows(page)).toHaveCount(1);
    await expect(pendingRows(page)).toContainText("<h1>");
    await expect(markers(page)).toHaveCount(1);
    await expect(composerInput(page)).toHaveValue("and the headline too");
    const after = await boxOf(panel(page));
    expect(after.x).toBeCloseTo(moved.x, 0);
    expect(after.y).toBeCloseTo(moved.y, 0);
  } finally {
    fs.writeFileSync(noticeSource, original);
  }
  await expect(notice).toHaveText(noticeCopy);
  expect(problems).toEqual([]);
});

test("a full reload brings back the unsent message and the panel's place, expanded", async ({
  page,
}) => {
  const opened = await runCli([reloadAppUrl], browserRecorder());
  expect(opened.exitCode).toBe(0);

  const problems = recordProblems(page);
  await page.goto(reloadAppUrl);
  await expect(panel(page)).toBeVisible();

  await composerInput(page).fill("half a thought about the counter");
  const moved = await dragPanel(page, -260, -160);
  await collapse(page).click();
  await expect(collapse(page)).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  await expect(panel(page)).toBeVisible();
  await expect(collapse(page)).toHaveAttribute("aria-expanded", "true");
  await expect(composerInput(page)).toHaveValue(
    "half a thought about the counter",
  );
  const restored = await boxOf(panel(page));
  expect(restored.x).toBeCloseTo(moved.x, 0);
  expect(restored.y).toBeCloseTo(moved.y, 0);

  // A sent message is no longer a draft: the next reload starts empty.
  await send(page, "half a thought about the counter, finished");
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await expect(composerInput(page)).toHaveValue("");
  expect(problems).toEqual([]);
});
