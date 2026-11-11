import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { daemonPort, viteBin } from "./support.ts";

/**
 * Behaviour 15: clicking inside a third-party component reports the `source`
 * of the app's own JSX that renders that component - its `<PortalWidget />`
 * call - also when the component portals its content to `<body>`, as
 * dropdowns, tooltips and dialogs from component libraries do.
 *
 * The spec serves its own fixture app (`fixtures/portal-app`) on its own port.
 */

const appDir = nodePath.join(import.meta.dirname, "fixtures", "portal-app");
const appPort = 52012;
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
      cwd: appDir,
      env: { ...process.env, INTERVU_PORT: String(daemonPort) },
      stdio: "ignore",
    },
  );
  await expect.poll(appAnswers, { timeout: 60_000 }).toBe(true);
});

test.afterAll(() => {
  devServer?.kill();
});

test("a click inside a portalled third-party component reports the app's call of that component", async ({
  page,
}) => {
  const browser = browserRecorder();
  expect((await runCli([appUrl], browser)).exitCode).toBe(0);
  expect(
    (await runCli(["poll", appUrl, "--timeout", "1"], browser)).exitCode,
  ).toBe(0);

  await page.goto(appUrl);
  await expect(page.locator("[data-intervu-panel]")).toBeVisible();
  const mainSource = nodePath.join(appDir, "src", "main.tsx");
  const lines = fs.readFileSync(mainSource, "utf8").split("\n");
  const callLine = lines.findIndex((line) => line.includes("<PortalWidget />"));
  expect(callLine).toBeGreaterThanOrEqual(0);
  const callSource = `${mainSource}:${callLine + 1}:${(lines[callLine] ?? "").indexOf("<PortalWidget />") + 1}`;

  await page.locator("[data-intervu-annotate]").click();
  await page.locator("#portal-label").click();
  await expect(page.locator("[data-intervu-pending-id]")).toHaveCount(1);
  await page.locator("[data-intervu-send]").click();
  await expect(page.locator("[data-intervu-pending-id]")).toHaveCount(0);

  const polled = await runCli(["poll", appUrl, "--timeout", "5"], browser);
  expect(polled.exitCode).toBe(0);
  const feedback = fieldOf(polled.output, "feedback");
  expect(feedback).toMatchObject([
    {
      annotations: [
        { tag: "span", text: "Portalled widget", source: callSource },
      ],
    },
  ]);
});
