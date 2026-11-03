import * as fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  armAnnotate,
  artifactFrame,
  artifactHtml,
  openPath,
  tempArtifact,
} from "./support.ts";

/**
 * The server-to-browser push slice end to end (issue #7): everything the daemon
 * pushes back to the browser rides one SSE channel off `SessionHub`. These specs
 * drive the four acceptance criteria - live-reload in place, agent-reply into the
 * panel, one merged Conversation thread, and the listening/working/idle Presence
 * indicator - each against its own temp artifact so a unique Session keeps the
 * parallel specs isolated.
 */

/** Arm annotate, capture one element, type a message, and Send to Agent. */
const sendFeedback = async (page: Page, message: string): Promise<void> => {
  await armAnnotate(page);
  await artifactFrame(page).locator("#native-btn").click();
  await expect(page.locator("[data-pending-list] li")).toHaveCount(1);
  await page.locator("[data-composer-input]").fill(message);
  const send = page.locator("[data-send]");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.locator("[data-composer-input]")).toHaveValue("");
};

test("presence reflects listening then working, all over one SSE channel", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("presence");

  const eventStreams: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/events")) {
      eventStreams.push(req.url());
    }
  });

  await openPath(page, request, base, file);
  const label = page.locator("[data-presence-label]");
  await expect(label).toHaveText("idle");

  // A poll opens: presence flips to listening over the SSE channel.
  const poll = request.post(`${base}/poll`, {
    data: { path: file },
    timeout: 30_000,
  });
  await expect(label).toHaveText("listening");

  // Sending feedback delivers to the poll and closes it: presence -> working.
  await sendFeedback(page, "tighten the heading");
  const response = await poll;
  expect(response.ok()).toBe(true);
  await expect(label).toHaveText("working");

  // The human message arrived as a thread bubble on that same one connection.
  await expect(page.locator("[data-conversation] [data-seq]")).toContainText(
    "tighten the heading",
  );
  expect(eventStreams).toHaveLength(1);
});

test("editing the artifact reloads only the iframe in place", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("VERSION ONE");

  const eventStreams: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/events")) {
      eventStreams.push(req.url());
    }
  });

  await openPath(page, request, base, file);
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "VERSION ONE",
  );

  // A sentinel on the top window proves the chrome itself never reloads.
  await page.evaluate(() => {
    document.title = "kept";
  });
  // Arm annotate so we can prove the mode survives a reload.
  await armAnnotate(page);

  // Edit the artifact on disk: the iframe live-reloads in place.
  fs.writeFileSync(file, artifactHtml("VERSION TWO"));
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "VERSION TWO",
    { timeout: 15_000 },
  );

  // The chrome did not reload (sentinel survives), annotate-mode was re-applied
  // to the fresh document, and the reload rode the one already-open SSE channel.
  expect(await page.title()).toBe("kept");
  await artifactFrame(page)
    .locator('html[data-intervu-mode="on"]')
    .waitFor({ timeout: 15_000 });
  expect(eventStreams).toHaveLength(1);
});

test("the SSE stream stays open past Bun's 10s idle timeout", async ({
  page,
  request,
  baseURL,
}) => {
  test.slow();
  const base = baseURL ?? "";
  const file = tempArtifact("STAYS OPEN");

  const eventStreams: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/events")) {
      eventStreams.push(req.url());
    }
  });

  await openPath(page, request, base, file);
  await page.waitForTimeout(16_000);
  expect(eventStreams).toHaveLength(1);

  // The one original stream still carries the reload.
  fs.writeFileSync(file, artifactHtml("STILL LIVE"));
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "STILL LIVE",
    { timeout: 5_000 },
  );
  expect(eventStreams).toHaveLength(1);
});

test("an edit made while the SSE stream is down lands on reconnect", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("BEFORE THE GAP");

  // Keep the stream down from the start, so no live nudge can deliver the edit.
  await page.route("**/events", (route) => route.abort());
  await openPath(page, request, base, file);
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "BEFORE THE GAP",
  );

  fs.writeFileSync(file, artifactHtml("DURING THE GAP"));
  await page.waitForTimeout(500);
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "BEFORE THE GAP",
  );

  // `EventSource` retries by itself; the version sent on connect does the rest.
  await page.unroute("**/events");
  await expect(artifactFrame(page).locator("#headline")).toHaveText(
    "DURING THE GAP",
    { timeout: 15_000 },
  );
});

test("a connect at the version already shown does not reload the artifact", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("UNCHANGED");

  await openPath(page, request, base, file);
  await artifactFrame(page).locator("#headline").waitFor();

  let reloads = 0;
  page.on("request", (req) => {
    if (req.url().includes("/a/?r=")) {
      reloads += 1;
    }
  });
  await page.waitForTimeout(1_000);
  expect(reloads).toBe(0);
});

test("a live-reload keeps the human's scroll position", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const tall = (headline: string): string =>
    artifactHtml(headline).replace(
      "</body>",
      '<div style="height:5000px"></div></body>',
    );
  const file = tempArtifact("TALL ONE");
  fs.writeFileSync(file, tall("TALL ONE"));
  await openPath(page, request, base, file);

  const frame = artifactFrame(page);
  await frame.locator("#headline").waitFor();
  await frame.locator("html").evaluate(() => {
    window.scrollTo({ top: 1200, behavior: "instant" });
  });
  // Give the SDK's frame-throttled report time to reach the chrome.
  await page.waitForTimeout(200);

  fs.writeFileSync(file, tall("TALL TWO"));
  await expect(frame.locator("#headline")).toHaveText("TALL TWO", {
    timeout: 15_000,
  });
  await expect
    .poll(() => frame.locator("html").evaluate(() => window.scrollY))
    .toBe(1200);
});

test("reply posts into the panel at once while a poll stays open", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("explore");
  await openPath(page, request, base, file);

  const poll = request.post(`${base}/poll`, {
    data: { path: file, timeoutSeconds: 30 },
    timeout: 30_000,
  });
  await expect(page.locator("[data-presence-label]")).toHaveText("listening");

  const reply = await request.post(`${base}/reply`, {
    data: { path: file, message: "looking at the billing code" },
  });
  expect(await reply.json()).toEqual({ posted: true, ended: false });
  const bubbles = page.locator("[data-conversation] [data-seq]");
  await expect(bubbles.nth(0)).toContainText("looking at the billing code");
  await expect(bubbles.nth(0)).toContainText("Agent");
  await expect(page.locator("[data-presence-label]")).toHaveText("listening");

  // The poll was undisturbed: a follow-up question still resolves it.
  await page.locator("[data-composer-input]").fill("and the invoices?");
  await page.locator("[data-send]").click();
  const response = await poll;
  expect(await response.json()).toMatchObject({
    feedback: [{ message: "and the invoices?" }],
  });
});

test("reply is refused for a blank message, an ended review, and an unopened path", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("refused");
  await openPath(page, request, base, file);

  const blank = await request.post(`${base}/reply`, {
    data: { path: file, message: "   " },
  });
  expect(await blank.json()).toEqual({ posted: false, ended: false });

  await request.post(`${base}/end`, { data: { path: file } });
  const ended = await request.post(`${base}/reply`, {
    data: { path: file, message: "too late" },
  });
  expect(await ended.json()).toEqual({ posted: false, ended: true });
  await expect(page.locator("[data-conversation] [data-seq]")).toHaveCount(0);

  const unopened = await request.post(`${base}/reply`, {
    data: { path: "/no/such/artifact.html", message: "hello" },
  });
  expect(unopened.status()).toBe(404);
});

test("agent-reply posts into the panel and the poll keeps waiting", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("reply");
  await openPath(page, request, base, file);

  // No feedback is queued, so this poll posts its reply then blocks.
  const poll = request.post(`${base}/poll`, {
    data: { path: file, agentReply: "tightened both", timeoutSeconds: 30 },
    timeout: 30_000,
  });

  const bubbles = page.locator("[data-conversation] [data-seq]");
  await expect(bubbles).toHaveCount(1);
  await expect(bubbles.nth(0)).toContainText("tightened both");
  await expect(bubbles.nth(0)).toContainText("Agent");

  // It really kept waiting: feedback sent now resolves the still-open poll.
  await sendFeedback(page, "now the spacing");
  const response = await poll;
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    timedOut: false,
    feedback: [{ message: "now the spacing" }],
  });
});

test("agent replies and reviewer messages read as one thread", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const file = tempArtifact("thread");
  await openPath(page, request, base, file);

  // The reviewer sends first (human bubble, right-aligned).
  await sendFeedback(page, "make it bolder");
  const bubbles = page.locator("[data-conversation] [data-seq]");
  await expect(bubbles).toHaveCount(1);
  await expect(bubbles.nth(0)).toContainText("Human");
  await expect(bubbles.nth(0)).toContainText("make it bolder");

  // The agent replies via poll --agent-reply (agent bubble, left-aligned). The
  // poll also drains the queued feedback and returns; the thread keeps both.
  const response = await request.post(`${base}/poll`, {
    data: { path: file, agentReply: "made it bolder", timeoutSeconds: 30 },
    timeout: 30_000,
  });
  expect(response.ok()).toBe(true);

  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.nth(1)).toContainText("Agent");
  await expect(bubbles.nth(1)).toContainText("made it bolder");
});
