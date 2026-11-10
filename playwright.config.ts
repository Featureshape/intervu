import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { defineConfig, devices } from "@playwright/test";
import {
  fixtureAppDir,
  fixtureAppPort,
  fixtureAppUrl,
  noDaemonAppPort,
  noDaemonAppUrl,
  previousViteAppDir,
  previousViteAppPort,
  previousViteAppUrl,
  previousViteBin,
  unusedDaemonPort,
  viteBin,
} from "./e2e/support.ts";

/**
 * The intervu E2E harness (issue #5 slice 3). Playwright boots the real daemon
 * (`bun src/main.ts server`) on a dedicated loopback port with a throwaway state
 * directory, then the specs drive the chrome, the sandboxed opaque-origin
 * artifact iframe, and the postMessage Bridge end to end. Kept out of the fast
 * `bun run test` (vitest) loop - run with `bun run test:e2e`.
 *
 * URL mode is proven against the fixture Vite + React app (`e2e/fixtures/app`),
 * served on Node with the `intervu/vite` plugin loaded from source: once wired to
 * the harness daemon, and once to a port no daemon listens on. The previous Vite
 * major serves the same app from its own workspace (`e2e/fixtures/app-previous-vite`).
 */

const PORT = 51990;
const baseURL = `http://127.0.0.1:${PORT}`;
const stateDir = path.join(os.tmpdir(), "intervu-e2e-state");

/**
 * Serve the fixture app with the Vite CLI `bin` from the config in `dir`, on
 * `port`, with its plugin pointed at `daemonPort`.
 */
const fixtureApp = ({
  bin,
  dir,
  port,
  url,
  daemonPort,
}: {
  readonly bin: string;
  readonly dir: string;
  readonly port: number;
  readonly url: string;
  readonly daemonPort: number;
}) => ({
  command: `node "${bin}" --port ${port} --strictPort`,
  cwd: dir,
  url,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: { INTERVU_PORT: String(daemonPort) },
});

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun src/main.ts server",
      url: `${baseURL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        INTERVU_PORT: String(PORT),
        INTERVU_STATE_DIR: stateDir,
      },
    },
    fixtureApp({
      bin: viteBin,
      dir: fixtureAppDir,
      port: fixtureAppPort,
      url: fixtureAppUrl,
      daemonPort: PORT,
    }),
    fixtureApp({
      bin: viteBin,
      dir: fixtureAppDir,
      port: noDaemonAppPort,
      url: noDaemonAppUrl,
      daemonPort: unusedDaemonPort,
    }),
    fixtureApp({
      bin: previousViteBin,
      dir: previousViteAppDir,
      port: previousViteAppPort,
      url: previousViteAppUrl,
      daemonPort: unusedDaemonPort,
    }),
  ],
});
