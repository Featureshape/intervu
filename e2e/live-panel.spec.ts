import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { conversationAppUrl } from "./support.ts";

/**
 * URL mode's live panel (behaviours 20, 21): every tab open on the origin
 * renders the Session's one Conversation from the SSE stream the plugin relays,
 * so an Agent-reply or a human's Send shows in all of them at once, and the
 * agent's Presence and the ended state show in the panel as they do in the
 * artifact chrome.
 *
 * The specs share one origin's Session and the last one ends it, so they run in
 * order; the first ends any Session a previous run left and opens a fresh one.
 */

test.describe.configure({ mode: "serial" });

const panel = (page: Page): Locator => page.locator("[data-intervu-panel]");

/** The bubble of `role` in the panel's Conversation that reads `text`. */
const bubble = (page: Page, role: "human" | "agent", text: string): Locator =>
  page
    .locator(`[data-intervu-conversation] .bubble[data-role="${role}"]`)
    .filter({ hasText: text });

const presenceLabel = (page: Page): Locator =>
  page.locator("[data-intervu-presence-label]");

/** Record the console errors and uncaught exceptions `page` reports. */
const recordProblems = (page: Page, problems: string[]): void => {
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
};

/**
 * Load the app in `page`, recording its problems from before the first byte,
 * and wait for the Session's panel.
 */
const showPanel = async (page: Page, problems: string[]): Promise<void> => {
  recordProblems(page, problems);
  await page.goto(conversationAppUrl);
  await expect(panel(page)).toBeVisible();
};

/** Open another tab on the app, showing the Session's panel. */
const openTab = async (
  context: BrowserContext,
  problems: string[],
): Promise<Page> => {
  const tab = await context.newPage();
  await showPanel(tab, problems);
  return tab;
};

test("intervu reply <url> shows the message in the panel of every open tab", async ({
  context,
}) => {
  const browser = browserRecorder();
  await runCli(["end", conversationAppUrl], browser);
  const opened = await runCli([conversationAppUrl], browser);
  expect(opened.exitCode).toBe(0);

  const problems: string[] = [];
  const first = await openTab(context, problems);
  const second = await openTab(context, problems);

  // The app's stream carries the Session's frames but no artifact version:
  // Vite's HMR, not the daemon, reloads the app.
  const tags = await first.evaluate(
    (url) =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const source = new EventSource(url);
        source.addEventListener("message", (event) => {
          seen.push(JSON.parse(event.data)._tag);
        });
        window.setTimeout(() => {
          source.close();
          resolve(seen);
        }, 500);
      }),
    `/__intervu/s/${fieldOf(opened.output, "key")}/events`,
  );
  expect(tags).toContain("PresenceChanged");
  expect(tags).not.toContain("ArtifactReloaded");

  const message = `Moved the header up - reply ${Date.now()}`;
  const replied = await runCli(["reply", conversationAppUrl, message], browser);
  expect(replied.exitCode).toBe(0);

  for (const tab of [first, second]) {
    await expect(bubble(tab, "agent", message)).toBeVisible();
    await expect(bubble(tab, "agent", message)).toContainText("Agent");
    await expect(tab.locator("[data-intervu-conversation-empty]")).toBeHidden();
  }
  expect(problems).toEqual([]);
});

test("a message sent from one tab appears live in the other tab's panel", async ({
  context,
}) => {
  const problems: string[] = [];
  const sender = await openTab(context, problems);
  const watcher = await openTab(context, problems);

  const message = `The footer overlaps the list - sent ${Date.now()}`;
  await sender.locator("[data-intervu-composer-input]").fill(message);
  await sender.locator("[data-intervu-send]").click();

  // The sender renders its own message from the stream too, not optimistically.
  await expect(bubble(sender, "human", message)).toBeVisible();
  await expect(bubble(watcher, "human", message)).toBeVisible();
  await expect(sender.locator("[data-intervu-composer-input]")).toHaveValue("");

  // A tab opened afterwards replays the Conversation so far.
  const late = await openTab(context, problems);
  await expect(bubble(late, "human", message)).toBeVisible();
  expect(problems).toEqual([]);
});

test("Presence shows while intervu poll <url> waits, and intervu end <url> shows the ended state", async ({
  page,
}) => {
  const browser = browserRecorder();
  // Drain what the previous spec sent, so the next poll waits.
  const drained = await runCli(
    ["poll", conversationAppUrl, "--timeout", "1"],
    browser,
  );
  expect(drained.exitCode).toBe(0);

  const problems: string[] = [];
  await showPanel(page, problems);
  await expect(presenceLabel(page)).not.toHaveText("listening");

  const polling = runCli(["poll", conversationAppUrl], browser);
  await expect(presenceLabel(page)).toHaveText("listening");
  await expect(
    page.locator('[data-intervu-presence] .dot[data-presence="listening"]'),
  ).toBeVisible();
  await expect(page.locator("[data-intervu-ended-pill]")).toBeHidden();

  // Arm Annotate first, so the end visibly hands the app its clicks back.
  await page.locator("[data-intervu-annotate]").click();
  await expect(page.locator("[data-intervu-annotate]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const ended = await runCli(["end", conversationAppUrl], browser);
  expect(ended.exitCode).toBe(0);
  expect((await polling).exitCode).toBe(0);

  await expect(page.locator("[data-intervu-ended-pill]")).toBeVisible();
  await expect(page.locator("[data-intervu-ended-pill]")).toHaveText("Ended");
  await expect(page.locator("[data-intervu-presence]")).toBeHidden();
  await expect(page.locator("[data-intervu-ended-note]")).toHaveText(
    "This review has ended.",
  );
  await expect(page.locator("[data-intervu-composer]")).toBeHidden();
  await expect(page.locator("[data-intervu-annotate]")).toBeDisabled();
  await expect(page.locator("[data-intervu-annotate]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // With the review over, the app's own handler runs again.
  await page.locator("#counter").click();
  await expect(page.locator("#counter")).toHaveText("Clicked 1 times");
  expect(problems).toEqual([]);
});
