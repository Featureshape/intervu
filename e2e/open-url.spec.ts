import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { fixtureAppUrl } from "./support.ts";

/**
 * URL mode's entry (behaviours 3, 5, 8): `intervu <url>` opens a Session keyed
 * by the app's origin and prints it as TOON, opening no browser tab unless
 * `--open` asks for one. The CLI is run for real against the harness daemon,
 * with a recorder standing in for the browser.
 */

test("intervu <url> opens the origin's Session, names the next poll and opens no tab", async () => {
  const browser = browserRecorder();
  const run = await runCli([fixtureAppUrl], browser);

  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  // `toMatchObject`, not `toEqual`: a concurrent spec's browser waiting at
  // another origin may legitimately add a `didYouMean` line to this open.
  expect(run.output).toMatchObject({
    key: expect.stringMatching(/^[0-9a-f]{16}$/),
    origin: fixtureAppUrl,
    status: "open",
    help: `review open - run 'intervu poll ${fixtureAppUrl}' to receive feedback`,
  });

  // A positive control on the same recorder: once a later `--open` run's tab
  // is logged, a tab the first run had asked for would be logged before it.
  const control = `${fixtureAppUrl}/control`;
  await runCli([control, "--open"], browser);
  await expect.poll(browser.opened).toContain(control);
  expect(browser.opened()).toEqual([control]);
});

test("intervu <url> --open opens a tab at the URL", async () => {
  const browser = browserRecorder();
  const url = `${fixtureAppUrl}/settings?tab=profile`;
  const run = await runCli([url, "--open"], browser);

  expect(run.exitCode).toBe(0);
  expect(run.output).toMatchObject({ origin: fixtureAppUrl, status: "open" });
  await expect.poll(browser.opened).toEqual([url]);
});

test("intervu <url> from a second route resumes the same Session", async () => {
  const browser = browserRecorder();
  const first = await runCli([fixtureAppUrl], browser);
  const second = await runCli([`${fixtureAppUrl}/settings#billing`], browser);

  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(first.output).toMatchObject({ origin: fixtureAppUrl });
  expect(second.output).toMatchObject({ origin: fixtureAppUrl });
  const key = fieldOf(first.output, "key");
  expect(key).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
  expect(fieldOf(second.output, "key")).toBe(key);
});
