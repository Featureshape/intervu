import * as fs from "node:fs";
import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import {
  annotate,
  composerInput,
  panel,
  pendingRows,
  sendButton,
} from "./panel.ts";
import { redactedAppUrl } from "./support.ts";

/**
 * Owner-configured redaction: the fixture app served with
 * `intervu({ redact: true })` masks every snapshot and annotation text in
 * the browser before anything leaves the page - letters to `x`, digits to
 * `0`, length and structure preserved - while the human's typed message,
 * selectors, ids and `data-intervu-src` stay intact, and the poll marks the
 * Feedback so the agent knows the placeholders are deliberate.
 *
 * The spec owns this origin's Session; it runs in order.
 */

test.describe.configure({ mode: "serial" });

test("a redacted Feedback leaves the page masked, structure intact", async ({
  page,
}) => {
  const browser = browserRecorder();
  const opened = await runCli([redactedAppUrl], browser);
  expect(opened.exitCode).toBe(0);
  // Drain anything an earlier run left queued.
  await runCli(["poll", redactedAppUrl, "--timeout", "1"], browser);

  await page.goto(redactedAppUrl);
  await expect(panel(page)).toBeVisible();

  await annotate(page).click();
  await expect(annotate(page)).toHaveAttribute("aria-pressed", "true");
  await page.locator("#headline").click();
  await expect(pendingRows(page)).toHaveCount(1);
  // Captured text is masked at the capture itself: the pending row already
  // shows placeholders, not the page's content.
  await expect(pendingRows(page)).toContainText("xxxxxxx xxx");

  await composerInput(page).fill("Please fix the header, row 7");
  await sendButton(page).click();
  await expect(pendingRows(page)).toHaveCount(0);

  const run = await runCli(["poll", redactedAppUrl, "--timeout", "5"], browser);
  expect(run.exitCode).toBe(0);
  const feedback = fieldOf(run.output, "feedback");
  const first = Array.isArray(feedback) ? (feedback[0] ?? null) : null;

  // The human's message is never redacted; the poll marks the redaction.
  expect(first).toMatchObject({
    message: "Please fix the header, row 7",
    redacted: true,
    annotations: [{ tag: "h1", text: "xxxxxxx xxx" }],
  });

  // Source mapping and selectors survive the masking.
  const annotations = fieldOf(first, "annotations");
  const row = Array.isArray(annotations) ? (annotations[0] ?? null) : null;
  expect(String(fieldOf(row, "source"))).toContain("App.tsx");
  const selector = String(fieldOf(row, "selector"));
  expect(
    await page.evaluate(
      (css) => document.querySelectorAll(css).length,
      selector,
    ),
  ).toBe(1);

  const snapshot = fs.readFileSync(
    String(fieldOf(first, "domSnapshotPath")),
    "utf8",
  );
  expect(snapshot).not.toContain("Fixture app");
  expect(snapshot).not.toContain("Ada Lovelace");
  expect(snapshot).not.toContain("4111");
  expect(snapshot).not.toContain("Third-party widget");
  expect(snapshot).toContain("xxxxxxx xxx");
  expect(snapshot).toContain('id="headline"');
  expect(snapshot).toContain("data-intervu-src");
});
