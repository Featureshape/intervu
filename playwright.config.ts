import process from "node:process";
import { defineConfig, devices } from "@playwright/test";
import {
  commandsAppPort,
  commandsAppUrl,
  compilerAppPort,
  compilerAppUrl,
  conversationAppPort,
  conversationAppUrl,
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
  redactedAppPort,
  redactedAppUrl,
  reloadAppPort,
  reloadAppUrl,
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
 * served on Node with the `intervu/vite` plugin loaded from source: five times
 * wired to the harness daemon (four instances for specs that end their Session
 * or count its Conversation), once more with the React Compiler on, once to a
 * port no daemon listens on, and once without the plugin at all. The previous Vite major serves the same app from
 * its own package (`e2e/fixtures/app-previous-vite`), installed from its own
 * lockfile before it starts. It is not a workspace of the root package: a root
 * `workspaces` field makes changesets treat the repo as a monorepo and refuse to
 * version `intervu` itself.
 */

const baseURL = `http://127.0.0.1:${daemonPort}`;

/**
 * Serve the fixture app with the Vite CLI `bin` from the config in `dir` (or
 * the file `config` there), on `port`, with `INTERVU_PORT` set to `daemonPort`
 * for its plugin, if the config loads one. `FIXTURE_APP_PORT` names `port` for
 * a config that keys its dependency cache by instance. With `install`, `dir`'s
 * own lockfile is installed first, for a fixture that pins its own Vite.
 */
const fixtureApp = ({
  bin,
  dir,
  config,
  port,
  url,
  daemonPort,
  install = false,
}: {
  readonly bin: string;
  readonly dir: string;
  readonly config?: string;
  readonly port: number;
  readonly url: string;
  readonly daemonPort: number;
  readonly install?: boolean;
}) => ({
  command: `${install ? "bun install --frozen-lockfile && " : ""}node "${bin}"${config === undefined ? "" : ` --config ${config}`} --port ${port} --strictPort`,
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
    ...[
      { port: fixtureAppPort, url: fixtureAppUrl },
      { port: endableAppPort, url: endableAppUrl },
      { port: panelAppPort, url: panelAppUrl },
      { port: conversationAppPort, url: conversationAppUrl },
      { port: reloadAppPort, url: reloadAppUrl },
      { port: commandsAppPort, url: commandsAppUrl },
    ].map(({ port, url }) =>
      fixtureApp({ bin: viteBin, dir: fixtureAppDir, port, url, daemonPort }),
    ),
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
      config: "vite.compiler.config.ts",
      port: compilerAppPort,
      url: compilerAppUrl,
      daemonPort,
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
      bin: viteBin,
      dir: fixtureAppDir,
      config: "vite.redact.config.ts",
      port: redactedAppPort,
      url: redactedAppUrl,
      daemonPort,
    }),
    fixtureApp({
      bin: previousViteBin,
      dir: previousViteAppDir,
      port: previousViteAppPort,
      url: previousViteAppUrl,
      daemonPort: unusedDaemonPort,
      install: true,
    }),
  ],
});
