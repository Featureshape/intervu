import process from "node:process";
import { defineConfig, devices } from "@playwright/test";
import {
  daemonPort,
  daemonStateDir,
  endableAppPort,
  endableAppUrl,
  fixtureAppDir,
  fixtureAppPort,
  fixtureAppUrl,
  noDaemonAppPort,
  noDaemonAppUrl,
  noPluginAppPort,
  noPluginAppUrl,
  panelAppPort,
  panelAppUrl,
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
 * served on Node with the `intervu/vite` plugin loaded from source: three times
 * wired to the harness daemon (two instances for specs that end their Session),
 * once to
 * a port no daemon listens on, and once without the plugin at all. The previous
 * Vite major serves the same app from its own workspace
 * (`e2e/fixtures/app-previous-vite`).
 */

const baseURL = `http://127.0.0.1:${daemonPort}`;

/**
 * Serve the fixture app with the Vite CLI `bin` from the config in `dir` (or
 * the file `config` there), on `port`, with `INTERVU_PORT` set to `daemonPort`
 * for its plugin, if the config loads one. `FIXTURE_APP_PORT` names `port` for
 * a config that keys its dependency cache by instance.
 */
const fixtureApp = ({
  bin,
  dir,
  config,
  port,
  url,
  daemonPort,
}: {
  readonly bin: string;
  readonly dir: string;
  readonly config?: string;
  readonly port: number;
  readonly url: string;
  readonly daemonPort: number;
}) => ({
  command: `node "${bin}"${config === undefined ? "" : ` --config ${config}`} --port ${port} --strictPort`,
  cwd: dir,
  url,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: { INTERVU_PORT: String(daemonPort), FIXTURE_APP_PORT: String(port) },
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
        INTERVU_PORT: String(daemonPort),
        INTERVU_STATE_DIR: daemonStateDir,
      },
    },
    fixtureApp({
      bin: viteBin,
      dir: fixtureAppDir,
      port: fixtureAppPort,
      url: fixtureAppUrl,
      daemonPort,
    }),
    fixtureApp({
      bin: viteBin,
      dir: fixtureAppDir,
      port: endableAppPort,
      url: endableAppUrl,
      daemonPort,
    }),
    fixtureApp({
      bin: viteBin,
      dir: fixtureAppDir,
      port: panelAppPort,
      url: panelAppUrl,
      daemonPort,
    }),
    fixtureApp({
      bin: viteBin,
      dir: fixtureAppDir,
      port: noDaemonAppPort,
      url: noDaemonAppUrl,
      daemonPort: unusedDaemonPort,
    }),
    fixtureApp({
      bin: viteBin,
      dir: fixtureAppDir,
      config: "vite.no-plugin.config.ts",
      port: noPluginAppPort,
      url: noPluginAppUrl,
      daemonPort,
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
