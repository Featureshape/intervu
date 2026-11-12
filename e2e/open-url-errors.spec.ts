import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { noPluginAppUrl, unreachableAppUrl } from "./support.ts";

/**
 * URL mode's two ways to meet an app that is not ready (behaviours 6, 7): no
 * answer at the URL fails fast with `AppUnreachable` and opens nothing, while an
 * app without the `intervu/vite` plugin still gets its Session, with a help line
 * saying how to add the plugin.
 */

test("intervu <url> with nothing listening exits 1 with AppUnreachable and opens no Session", async () => {
  const browser = browserRecorder();
  const run = await runCli([unreachableAppUrl, "--open"], browser);

  expect(run.exitCode).toBe(1);
  expect(run.output).toEqual({
    error: {
      tag: "AppUnreachable",
      message: `nothing answered at ${unreachableAppUrl}/`,
    },
    help: `start the app's dev server, then re-run 'intervu ${unreachableAppUrl}/'`,
  });

  const home = await runCli([], browser);
  expect(home.exitCode).toBe(0);
  const sessions = fieldOf(home.output, "sessions");
  expect(Array.isArray(sessions)).toBe(true);
  expect(sessions).not.toContainEqual(
    expect.objectContaining({ path: unreachableAppUrl }),
  );
  expect(browser.opened()).toEqual([]);
});

test("intervu <url> without the plugin opens the Session and says how to add it", async () => {
  const browser = browserRecorder();
  const run = await runCli([noPluginAppUrl], browser);

  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  // `toMatchObject`, not `toEqual`: a concurrent spec's browser waiting at
  // another origin may legitimately add a `didYouMean` line to this open.
  expect(run.output).toMatchObject({
    key: expect.stringMatching(/^[0-9a-f]{16}$/),
    origin: noPluginAppUrl,
    status: "open",
    help: `review open, but the intervu Vite plugin is missing at ${noPluginAppUrl} - add \`import { intervu } from "intervu/vite"\` and \`intervu()\` to the plugins in vite.config.ts and restart the dev server, then run 'intervu poll ${noPluginAppUrl}' to receive feedback`,
  });
});
