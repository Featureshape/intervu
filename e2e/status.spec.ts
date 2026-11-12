import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import {
  daemonPort,
  daemonStateDir,
  fixtureAppPort,
  fixtureAppUrl,
} from "./support.ts";

/**
 * `intervu status`, the live diagnostics read: the daemon names itself
 * (version, port, state dir), and once a tab's relay requests pass the guard
 * the plugin reports in - its own origin, the page origins it has seen
 * succeed, and after a refused request a tally naming the rejection reason.
 * The Home view stays offline; this is the one command that talks to the
 * daemon.
 */

/** One `intervu status` run, decoded. */
const statusOutput = async () => {
  const run = await runCli(["status"], browserRecorder());
  expect(run.exitCode).toBe(0);
  return run.output;
};

test("status names the daemon's version, port and state dir", async () => {
  const output = await statusOutput();
  expect(typeof fieldOf(output, "version")).toBe("string");
  expect(fieldOf(output, "port")).toBe(daemonPort);
  expect(fieldOf(output, "stateDir")).toBe(daemonStateDir);
  expect(Array.isArray(fieldOf(output, "sessions"))).toBe(true);
});

test("a tab on the fixture app shows up as a reporting plugin", async ({
  page,
}) => {
  // The page's first relay lookup is a newly seen origin, which the plugin
  // reports promptly; the daemon then lists the sighting.
  await page.goto(fixtureAppUrl);
  await expect
    .poll(
      async () =>
        JSON.stringify(fieldOf(await statusOutput(), "plugins") ?? []),
      { timeout: 15_000 },
    )
    .toContain(`http://localhost:${fixtureAppPort}`);

  const plugins = fieldOf(await statusOutput(), "plugins");
  const sighting = (Array.isArray(plugins) ? plugins : []).find(
    (plugin) =>
      fieldOf(plugin, "origin") === `http://localhost:${fixtureAppPort}`,
  );
  expect(sighting).toBeDefined();
  expect(JSON.stringify(fieldOf(sighting ?? null, "seenOrigins"))).toContain(
    fixtureAppUrl,
  );
  expect(typeof fieldOf(sighting ?? null, "lastSeenAt")).toBe("string");
});

test("a refused request shows up as a refusal tally with its reason", async ({
  request,
}) => {
  const refused = await request.get(`${fixtureAppUrl}/__intervu/health`, {
    headers: { Origin: "http://evil.example" },
  });
  expect(refused.status()).toBe(403);

  await expect
    .poll(
      async () =>
        JSON.stringify(fieldOf(await statusOutput(), "refusals") ?? []),
      { timeout: 15_000 },
    )
    .toContain("foreign-origin");

  const refusals = fieldOf(await statusOutput(), "refusals");
  const tally = (Array.isArray(refusals) ? refusals : []).find(
    (row) => fieldOf(row, "origin") === "http://evil.example",
  );
  expect(tally).toBeDefined();
  expect(fieldOf(tally ?? null, "reason")).toBe("foreign-origin");
  expect(fieldOf(tally ?? null, "plugin")).toBe(
    `http://localhost:${fixtureAppPort}`,
  );
});
