import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test } from "@playwright/test";
import { hasField } from "../src/hasField.ts";
import { browserRecorder, runCliRaw } from "./cli.ts";
import { panel } from "./panel.ts";
import { fixtureAppDir, viteBin } from "./support.ts";

/**
 * Two agents in two sandboxes, each with its own daemon, coexist on the
 * fixed port range 51789-51798: each daemon binds the first free port and
 * leaves a stranger's daemon alone, `/health` names whose daemon each one is
 * (state dir + instance id), the range-scanning CLI finds its own daemon by
 * state dir, and the plugin's relay fans out across the range - finding a
 * Session on either daemon and, when both hold one for the same origin,
 * using the most recently active and logging a warning naming both ports.
 *
 * The spec owns both daemons and its own dev server; it runs in order.
 */

test.describe.configure({ mode: "serial" });

const repoRoot = nodePath.join(import.meta.dirname, "..");
const rangePorts = Array.from({ length: 10 }, (_, index) => 51789 + index);
const vitePort = 52018;
const appUrl = `http://localhost:${vitePort}`;

const daemons: ChildProcess[] = [];
let devServer: ChildProcess | undefined;
let devServerLog = "";
let stateDirA = "";
let stateDirB = "";
let portA = 0;
let portB = 0;

/** The environment a spec-owned process runs with: no harness pinning. */
const rawEnv = (stateDir: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INTERVU_STATE_DIR: stateDir,
    // The spec's daemons must not idle-shutdown between its tests.
    INTERVU_IDLE_TIMEOUT: "86400",
  };
  delete env.INTERVU_PORT;
  return env;
};

/** The `/health` identity on `port`, or `null` when nothing answers. */
const healthOn = async (
  port: number,
): Promise<{
  readonly stateDir: string | undefined;
  readonly instanceId: string | undefined;
} | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    return {
      stateDir:
        hasField(body, "stateDir") && typeof body.stateDir === "string"
          ? body.stateDir
          : undefined,
      instanceId:
        hasField(body, "instanceId") && typeof body.instanceId === "string"
          ? body.instanceId
          : undefined,
    };
  } catch {
    return null;
  }
};

/** The range port whose daemon owns `stateDir`, or 0 while it binds. */
const portOf = async (stateDir: string): Promise<number> => {
  for (const port of rangePorts) {
    const health = await healthOn(port);
    if (health?.stateDir === stateDir) {
      return port;
    }
  }
  return 0;
};

/** Start a daemon owning `stateDir` and return the range port it bound. */
const startDaemon = async (stateDir: string): Promise<number> => {
  const child = spawn(
    "bun",
    [nodePath.join(repoRoot, "src", "main.ts"), "server"],
    { env: rawEnv(stateDir), stdio: "ignore" },
  );
  daemons.push(child);
  await expect.poll(() => portOf(stateDir), { timeout: 15_000 }).not.toBe(0);
  return portOf(stateDir);
};

test.beforeAll(async () => {
  test.setTimeout(120_000);
  stateDirA = fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-coex-a-"));
  stateDirB = fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-coex-b-"));
  portA = await startDaemon(stateDirA);
  portB = await startDaemon(stateDirB);

  // The spec's own dev server, with no INTERVU_PORT: its plugin scans the
  // whole range, which is the point.
  devServer = spawn(
    "node",
    [viteBin, "--port", String(vitePort), "--strictPort"],
    {
      cwd: fixtureAppDir,
      env: (() => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          FIXTURE_APP_PORT: String(vitePort),
        };
        delete env.INTERVU_PORT;
        return env;
      })(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const record = (chunk: Buffer): void => {
    devServerLog += chunk.toString("utf8");
  };
  devServer.stdout?.on("data", record);
  devServer.stderr?.on("data", record);
  await expect
    .poll(
      () =>
        fetch(appUrl)
          .then((response) => response.ok)
          .catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);
});

test.afterAll(() => {
  devServer?.kill();
  for (const daemon of daemons) {
    daemon.kill();
  }
});

test("each daemon binds its own range port and /health names whose it is", async () => {
  expect(rangePorts).toContain(portA);
  expect(rangePorts).toContain(portB);
  expect(portB).toBeGreaterThan(portA);

  const healthA = await healthOn(portA);
  const healthB = await healthOn(portB);
  expect(healthA?.stateDir).toBe(stateDirA);
  expect(healthB?.stateDir).toBe(stateDirB);
  expect(typeof healthA?.instanceId).toBe("string");
  expect(healthA?.instanceId).not.toBe(healthB?.instanceId);

  // The second daemon did not evict the first: both still answer.
  expect(healthA).not.toBeNull();
  expect(healthB).not.toBeNull();
});

test("the range-scanning CLI finds its own daemon by state dir", async () => {
  // Daemon B's CLI must land on daemon B, not the lower-port daemon A.
  const run = await runCliRaw(["status"], browserRecorder(), {
    INTERVU_STATE_DIR: stateDirB,
  });
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain(`port: ${portB}`);
  expect(run.stdout).toContain(stateDirB);
  // And it remembers the port for the next command in this agent session.
  expect(
    fs.readFileSync(nodePath.join(stateDirB, "daemon.port"), "utf8").trim(),
  ).toBe(String(portB));
});

test("the relay finds a Session opened on either daemon", async ({ page }) => {
  // Opened against daemon B (the CLI scans and finds it by state dir).
  const opened = await runCliRaw([appUrl], browserRecorder(), {
    INTERVU_STATE_DIR: stateDirB,
  });
  expect(opened.exitCode).toBe(0);

  await page.goto(appUrl);
  await expect(panel(page)).toBeVisible();

  // Ended on B, opened on A: the same tab's relay finds the new Session.
  await runCliRaw(["end", appUrl], browserRecorder(), {
    INTERVU_STATE_DIR: stateDirB,
  });
  const onA = await runCliRaw([appUrl], browserRecorder(), {
    INTERVU_STATE_DIR: stateDirA,
  });
  expect(onA.exitCode).toBe(0);
  await page.goto(appUrl);
  await expect(panel(page)).toBeVisible();
});

test("two daemons holding one origin's Session is a logged tie, won by the fresher", async ({
  page,
}) => {
  // Daemon A already holds the Session from the previous test; open it on B
  // too, later, so B is the most recently active.
  const onB = await runCliRaw([appUrl], browserRecorder(), {
    INTERVU_STATE_DIR: stateDirB,
  });
  expect(onB.exitCode).toBe(0);

  await page.goto(appUrl);
  await expect(panel(page)).toBeVisible();
  await expect
    .poll(() => devServerLog)
    .toContain(
      `two daemons hold an open Session for ${appUrl} (ports ${portA}, ${portB}); using ${portB}`,
    );
});
