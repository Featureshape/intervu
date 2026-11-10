import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { decode, type JsonObject, type JsonValue } from "@toon-format/toon";
import { daemonPort, daemonStateDir } from "./support.ts";

/**
 * Run the real `intervu` CLI the way an agent does (`bun src/main.ts ...`),
 * against the harness daemon and its state directory, and decode the TOON it
 * prints. Specs drive URL mode's CLI half through this: what the agent sees is
 * stdout, so it cannot be asserted through the daemon's HTTP routes alone.
 *
 * Every run points `INTERVU_BROWSER` at a recorder script instead of the OS
 * browser, so a run never opens a real tab and a spec can tell whether the CLI
 * asked for one.
 */

const repoRoot = nodePath.join(import.meta.dirname, "..");

/** The URLs the CLI asked the browser to open, in order. */
export interface BrowserRecorder {
  readonly command: string;
  readonly opened: () => readonly string[];
}

/**
 * A stand-in browser: an executable that appends the URL it is given to a log
 * in its own temp directory.
 */
export const browserRecorder = (): BrowserRecorder => {
  const dir = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), "intervu-e2e-browser-"),
  );
  const log = nodePath.join(dir, "opened.log");
  const command = nodePath.join(dir, "browser.sh");
  fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`, {
    mode: 0o755,
  });
  return {
    command,
    opened: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
        : [],
  };
};

/** One finished CLI run: its exit code, raw streams and decoded stdout. */
export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: JsonValue;
}

/** Run `intervu <args>` to completion with `browser` standing in for the OS's. */
export const runCli = (
  args: readonly string[],
  browser: BrowserRecorder,
): Promise<CliRun> =>
  new Promise((resolve) => {
    execFile(
      "bun",
      ["src/main.ts", ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          INTERVU_PORT: String(daemonPort),
          INTERVU_STATE_DIR: daemonStateDir,
          INTERVU_BROWSER: browser.command,
        },
      },
      (error, stdout, stderr) => {
        const exitCode =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({
          exitCode,
          stdout,
          stderr,
          output: stdout.trim() === "" ? null : decode(stdout),
        });
      },
    );
  });

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `name` field of a decoded TOON object, or `undefined` when absent. */
export const fieldOf = (
  output: JsonValue,
  name: string,
): JsonValue | undefined => (isJsonObject(output) ? output[name] : undefined);
