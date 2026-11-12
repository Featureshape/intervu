import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCliRaw } from "./cli.ts";
import { artifactHtml } from "./support.ts";

/**
 * The state-dir fallback: inside a sandbox `~/.local/state` is often not
 * writable, so commands run against `$TMPDIR/intervu-<user>` instead of
 * failing - the CLI says so on stderr, the daemon it spawns with the same
 * environment lands on the same fallback, and `intervu status` names the
 * state dir in use.
 */

test.describe.configure({ mode: "serial" });

/** An unwritable state dir: a path under a read-only file. */
const blockedDir = (() => {
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-ro-"));
  const file = nodePath.join(base, "wall");
  fs.writeFileSync(file, "not a directory");
  return nodePath.join(file, "state");
})();

/** The deterministic fallback both the CLI and its daemon resolve. */
const fallbackDir = nodePath.join(
  os.tmpdir(),
  `intervu-${process.env.USER ?? "user"}`,
);

/** A pinned spare port, so this spec's daemon stays out of the range. */
const env = {
  INTERVU_STATE_DIR: blockedDir,
  INTERVU_PORT: "51972",
};

test.afterAll(async () => {
  await runCliRaw(["stop"], browserRecorder(), env);
});

test("commands run against the $TMPDIR fallback and say so", async () => {
  const artifact = nodePath.join(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-fb-art-")),
    "a.html",
  );
  fs.writeFileSync(artifact, artifactHtml("fallback"));

  const opened = await runCliRaw([artifact], browserRecorder(), env);
  expect(opened.exitCode).toBe(0);
  expect(fieldOf(opened.output, "status")).toBe("open");
  expect(opened.stderr).toContain("is not writable");
  expect(opened.stderr).toContain(fallbackDir);
  // The state landed in the fallback, not nowhere.
  expect(fs.existsSync(nodePath.join(fallbackDir, "state.json"))).toBe(true);
});

test("intervu status names the state dir in use", async () => {
  const run = await runCliRaw(["status"], browserRecorder(), env);
  expect(run.exitCode).toBe(0);
  // Both the CLI and the daemon compute the same literal fallback path.
  expect(String(fieldOf(run.output, "stateDir"))).toBe(fallbackDir);
});
