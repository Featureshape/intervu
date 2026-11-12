import { expect, test } from "@playwright/test";
import type { JsonValue } from "@toon-format/toon";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import {
  fixtureAppUrl,
  noDaemonAppUrl,
  noPluginAppUrl,
  unusedDaemonPort,
} from "./support.ts";

/**
 * `intervu doctor <url>` replays the overlay's exact lookup - `?origin=` and
 * the Origin header always included, so the false pass a bare `curl` gives
 * cannot happen - and prints a per-check verdict: all five pass against the
 * wired fixture app with its Session open, the daemon check fails naming the
 * port when nothing listens behind the plugin, and the plugin check fails
 * where the app has no plugin at all. Any failure exits non-zero.
 */

/** The `checks` rows of a doctor run, keyed by check name. */
const checksOf = (output: JsonValue) => {
  const checks = fieldOf(output, "checks");
  return (name: string): JsonValue =>
    (Array.isArray(checks) ? checks : []).find(
      (row) => fieldOf(row, "check") === name,
    ) ?? null;
};

test("every check passes against the wired fixture app with its Session open", async () => {
  const opened = await runCli([fixtureAppUrl], browserRecorder());
  expect(opened.exitCode).toBe(0);

  const run = await runCli(["doctor", fixtureAppUrl], browserRecorder());
  expect(run.exitCode).toBe(0);
  const check = checksOf(run.output);
  for (const name of [
    "app-reachable",
    "plugin-answering",
    "guard",
    "daemon-from-plugin",
    "open-session",
  ]) {
    expect(fieldOf(check(name), "result"), name).toBe("pass");
  }
  expect(String(fieldOf(run.output, "help"))).toContain("every check passes");
});

test("with no daemon behind the plugin, the daemon check fails naming the port", async () => {
  const run = await runCli(["doctor", noDaemonAppUrl], browserRecorder());
  expect(run.exitCode).not.toBe(0);
  const check = checksOf(run.output);
  expect(fieldOf(check("plugin-answering"), "result")).toBe("pass");
  expect(fieldOf(check("guard"), "result")).toBe("pass");
  expect(fieldOf(check("daemon-from-plugin"), "result")).toBe("fail");
  expect(String(fieldOf(check("daemon-from-plugin"), "detail"))).toContain(
    String(unusedDaemonPort),
  );
  expect(fieldOf(check("open-session"), "result")).toBe("skipped");
});

test("without the plugin, the plugin check fails with the wiring hint", async () => {
  const run = await runCli(["doctor", noPluginAppUrl], browserRecorder());
  expect(run.exitCode).not.toBe(0);
  const check = checksOf(run.output);
  expect(fieldOf(check("app-reachable"), "result")).toBe("pass");
  expect(fieldOf(check("plugin-answering"), "result")).toBe("fail");
  expect(String(fieldOf(check("plugin-answering"), "hint"))).toContain(
    "vite.config.ts",
  );
  expect(fieldOf(check("guard"), "result")).toBe("skipped");
});
