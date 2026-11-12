import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { unusedDaemonPort, viteBin } from "./support.ts";

/**
 * `intervu setup vite` writes the bundled dependency-free ESM plugin to
 * `<project>/.intervu/vite.mjs` - no package manager, no network - prints
 * the exact import line and config edit, is a no-op on the second run, and
 * never touches the config itself. The written file then loads in a real
 * Vite config: a dev server built on it serves the relay.
 */

test.describe.configure({ mode: "serial" });

const project = fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-sv-"));
const pluginFile = nodePath.join(project, ".intervu", "vite.mjs");
const vitePort = 52024;

let devServer: ChildProcess | undefined;

test.afterAll(() => {
  devServer?.kill();
});

test("writes the plugin once, prints the human edit, and re-runs as a no-op", async () => {
  const first = await runCli(["setup", "vite"], browserRecorder(), {
    cwd: project,
  });
  expect(first.exitCode).toBe(0);
  expect(fieldOf(first.output, "action")).toBe("installed");
  // macOS resolves the temp dir's symlink in the child's cwd; the suffix is
  // the contract.
  expect(String(fieldOf(first.output, "path"))).toMatch(
    /\/\.intervu\/vite\.mjs$/,
  );
  expect(String(fieldOf(first.output, "importLine"))).toBe(
    'import { intervu } from "./.intervu/vite.mjs";',
  );
  expect(String(fieldOf(first.output, "configEdit"))).toContain("intervu()");
  const written = fs.readFileSync(pluginFile, "utf8");
  expect(written).toContain("export");

  const second = await runCli(["setup", "vite"], browserRecorder(), {
    cwd: project,
  });
  expect(second.exitCode).toBe(0);
  expect(fieldOf(second.output, "action")).toBe("already-present");
  expect(fs.readFileSync(pluginFile, "utf8")).toBe(written);
  // No config file appeared: the config edit stays human.
  expect(fs.existsSync(nodePath.join(project, "vite.config.ts"))).toBe(false);
});

test("the written file loads in a Vite config and serves the relay", async () => {
  test.setTimeout(60_000);
  fs.writeFileSync(
    nodePath.join(project, "index.html"),
    '<!doctype html><html><body><h1 id="headline">Setup vite fixture</h1></body></html>',
  );
  fs.writeFileSync(
    nodePath.join(project, "vite.config.mjs"),
    [
      'import { intervu } from "./.intervu/vite.mjs";',
      "export default { plugins: [intervu()] };",
      "",
    ].join("\n"),
  );

  devServer = spawn(
    "node",
    [viteBin, "--port", String(vitePort), "--strictPort"],
    {
      cwd: project,
      env: { ...process.env, INTERVU_PORT: String(unusedDaemonPort) },
      stdio: "ignore",
    },
  );
  const appUrl = `http://localhost:${vitePort}`;
  await expect
    .poll(
      () =>
        fetch(appUrl)
          .then((response) => response.ok)
          .catch(() => false),
      { timeout: 45_000 },
    )
    .toBe(true);

  // The relay answers beside the app: the plugin is live from the written file.
  const lookup = await fetch(
    `${appUrl}/__intervu/session?origin=${encodeURIComponent(appUrl)}`,
  );
  expect(lookup.status).toBe(200);
  const answer = await lookup.text();
  expect(answer).toContain('"session":null');
  // And the page gets the overlay script injected.
  const page = await fetch(appUrl).then((response) => response.text());
  expect(page).toContain("/__intervu/overlay.js");
});
