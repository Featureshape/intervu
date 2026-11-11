import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { type HttpsProxy, startHttpsProxy } from "./httpsProxy.ts";
import { composerInput, panel, sendButton } from "./panel.ts";
import { daemonPort, fixtureAppDir, viteBin } from "./support.ts";

/**
 * URL mode behind a TLS-terminating reverse proxy: the browser is on
 * `https://localhost:<proxy>`, while the dev server behind it serves plain http
 * and only sees the proxy's forwarded headers. The overlay must load, find the
 * Session `intervu <https url>` opened, and send Feedback through the proxy;
 * a body the proxy refuses for size must still deliver the human's note and
 * say why; and a request the relay refuses must say why in the dev server's
 * log.
 *
 * The spec serves the fixture app on its own port, with its own proxy, and
 * shares one Session across its tests, so they run in order.
 */

test.describe.configure({ mode: "serial" });
test.use({ ignoreHTTPSErrors: true });

const vitePort = 52013;
const proxyPort = 52014;
/** nginx's default `client_body_buffer_size` on 64-bit platforms. */
const bodyLimit = 16 * 1024;

let devServer: ChildProcess | undefined;
let proxy: HttpsProxy | undefined;
let devServerLog = "";

/** The proxy's https URL, the one the human and the agent use. */
const appUrl = `https://localhost:${proxyPort}`;

const appAnswers = (): Promise<boolean> =>
  fetch(`http://localhost:${vitePort}`)
    .then((response) => response.ok)
    .catch(() => false);

test.beforeAll(async () => {
  test.setTimeout(90_000);
  devServer = spawn(
    "node",
    [viteBin, "--port", String(vitePort), "--strictPort"],
    {
      cwd: fixtureAppDir,
      env: {
        ...process.env,
        INTERVU_PORT: String(daemonPort),
        FIXTURE_APP_PORT: String(vitePort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const record = (chunk: Buffer): void => {
    devServerLog += chunk.toString("utf8");
  };
  devServer.stdout?.on("data", record);
  devServer.stderr?.on("data", record);
  await expect.poll(appAnswers, { timeout: 60_000 }).toBe(true);
  proxy = await startHttpsProxy({ port: proxyPort, vitePort, bodyLimit });
});

test.afterAll(async () => {
  await proxy?.close();
  devServer?.kill();
});

/** Poll the Session the way the agent does; its one Feedback. */
const pollOne = async () => {
  const run = await runCli(
    ["poll", appUrl, "--timeout", "5"],
    browserRecorder(),
  );
  expect(run.exitCode).toBe(0);
  const feedback = fieldOf(run.output, "feedback");
  expect(Array.isArray(feedback) ? feedback : []).toHaveLength(1);
  return Array.isArray(feedback) ? (feedback[0] ?? null) : null;
};

test("intervu <https url> opens a Session the plugin behind the proxy sees", async () => {
  const browser = browserRecorder();
  const opened = await runCli([appUrl], browser);
  expect(opened.stderr).toBe("");
  expect(opened.exitCode).toBe(0);
  expect(fieldOf(opened.output, "origin")).toBe(appUrl);
  expect(fieldOf(opened.output, "help")).toBe(
    `review open - run 'intervu poll ${appUrl}' to receive feedback`,
  );
  // Drain anything an earlier run left queued.
  await runCli(["poll", appUrl, "--timeout", "1"], browser);
});

test("the overlay loads through the proxy and its Feedback reaches the agent", async ({
  page,
}) => {
  await page.goto(appUrl);
  await expect(panel(page)).toBeVisible();

  await composerInput(page).fill("Behind the proxy");
  await sendButton(page).click();
  await expect(composerInput(page)).toHaveValue("");
  await expect(page.locator("[data-intervu-send-status]")).toBeHidden();

  const feedback = await pollOne();
  expect(feedback).toMatchObject({ message: "Behind the proxy" });
  const snapshotPath =
    feedback === null ? undefined : fieldOf(feedback, "domSnapshotPath");
  expect(typeof snapshotPath).toBe("string");
  const snapshot =
    typeof snapshotPath === "string"
      ? fs.readFileSync(snapshotPath, "utf8")
      : "";
  expect(snapshot).toContain('id="headline"');
  expect(snapshot).not.toContain("<script");
});

test("a send the proxy refuses for size still delivers the note, and says why", async ({
  page,
}) => {
  await page.goto(appUrl);
  await expect(panel(page)).toBeVisible();
  // A page well past the proxy's body limit.
  await page.evaluate((size) => {
    const filler = document.createElement("p");
    filler.id = "filler";
    filler.textContent = "lorem ipsum ".repeat(size / 12);
    document.body.append(filler);
  }, 4 * bodyLimit);

  await composerInput(page).fill("A long page");
  await sendButton(page).click();
  await expect(composerInput(page)).toHaveValue("");
  await expect(page.locator("[data-intervu-send-status]")).toHaveText(
    "Sent without the page snapshot - HTTP 413 Request Entity Too Large: 413 Request Entity Too Large 413 Request Entity Too Large nginx",
  );

  const feedback = await pollOne();
  expect(feedback).toMatchObject({ message: "A long page" });
  const snapshotPath =
    feedback === null ? undefined : fieldOf(feedback, "domSnapshotPath");
  const snapshot =
    typeof snapshotPath === "string"
      ? fs.readFileSync(snapshotPath, "utf8")
      : "";
  expect(snapshot).toContain(
    "intervu: the page snapshot could not be sent with this Feedback (HTTP 413",
  );
});

test("a request the relay refuses says why in the dev server's log", async ({
  request,
}) => {
  const response = await request.get(`${appUrl}/__intervu/overlay.js`, {
    headers: { Origin: "https://evil.example" },
  });
  expect(response.status()).toBe(403);
  await expect
    .poll(() => devServerLog)
    .toContain(
      `[intervu] refused GET /__intervu/overlay.js: its Origin is not an address this dev server answers to`,
    );
  expect(devServerLog).toContain(
    `Host: localhost:${proxyPort}, Origin: https://evil.example`,
  );
});
