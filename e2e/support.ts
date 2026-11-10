import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  type APIRequestContext,
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Shared E2E helpers: open a session for the committed fixture and drive the
 * annotate-mode gestures the way a reviewer does. The artifact iframe is a
 * sandboxed opaque origin, so the in-iframe SDK announces its readiness only by
 * the `data-intervu-mode` attribute it writes on `<html>`; raw `page.mouse`
 * gestures wait on that signal first (frameLocator `.click()` auto-waits on its
 * own actionability and needs no extra gate).
 */

/** The harness daemon's loopback port and its throwaway state directory. */
export const daemonPort = 51990;
export const daemonStateDir = nodePath.join(os.tmpdir(), "intervu-e2e-state");

/** The fixture Vite + React app, its plugin wired to the harness daemon. */
export const fixtureAppPort = 51991;
export const fixtureAppUrl = `http://localhost:${fixtureAppPort}`;

/** The same fixture app, its plugin pointed at a port no daemon listens on. */
export const noDaemonAppPort = 51992;
export const noDaemonAppUrl = `http://localhost:${noDaemonAppPort}`;
export const unusedDaemonPort = 51993;

/** The same fixture app served without the `intervu/vite` plugin. */
export const noPluginAppPort = 51995;
export const noPluginAppUrl = `http://localhost:${noPluginAppPort}`;

/**
 * The same fixture app wired to the harness daemon, for specs that end its
 * Session: a Session is keyed by origin, so ending this one never races the
 * specs that keep the fixture app's Session open.
 */
export const endableAppPort = 51997;
export const endableAppUrl = `http://localhost:${endableAppPort}`;

/**
 * The same fixture app wired to the harness daemon, for the floating-panel spec:
 * it ends and re-opens this origin's Session to watch the badge give way to the
 * panel, so no other spec may hold that Session open.
 */
export const panelAppPort = 51998;
export const panelAppUrl = `http://localhost:${panelAppPort}`;

/**
 * The same fixture app wired to the harness daemon, for the live-panel spec:
 * it ends this origin's Session to watch the panel show the ended state, so no
 * other spec may hold that Session open.
 */
export const conversationAppPort = 51999;
export const conversationAppUrl = `http://localhost:${conversationAppPort}`;

/**
 * The same fixture app wired to the harness daemon, for the HMR and reload
 * spec: it counts the Conversation and the pending annotations across an edit
 * and a reload, so no other spec may send to that Session.
 */
export const reloadAppPort = 52000;
export const reloadAppUrl = `http://localhost:${reloadAppPort}`;

/** A port no app listens on, for `intervu <url>` to find nothing at. */
export const unreachableAppUrl = "http://localhost:51996";

/** The same fixture app on the previous Vite major, its daemon port unused. */
export const previousViteAppPort = 51994;
export const previousViteAppUrl = `http://localhost:${previousViteAppPort}`;

/** The fixture app's directory, the root Vite serves and builds. */
export const fixtureAppDir = nodePath.join(
  import.meta.dirname,
  "fixtures",
  "app",
);

/** The workspace that serves the fixture app on the previous Vite major. */
export const previousViteAppDir = nodePath.join(
  import.meta.dirname,
  "fixtures",
  "app-previous-vite",
);

/** The Vite CLI installed under `nodeModules`, run on Node like a user's. */
const viteBinIn = (nodeModules: string): string =>
  nodePath.join(nodeModules, "vite", "bin", "vite.js");

/** The current Vite major's CLI. */
export const viteBin = viteBinIn(
  nodePath.join(import.meta.dirname, "..", "node_modules"),
);

/** The previous Vite major's CLI, installed in its fixture workspace. */
export const previousViteBin = viteBinIn(
  nodePath.join(previousViteAppDir, "node_modules"),
);

/** The absolute path of the committed fixture, the artifact under review. */
export const fixturePath = new URL("./fixtures/artifact.html", import.meta.url)
  .pathname;

/** The in-iframe SDK marks `<html>` with its current Annotate-mode. */
const modeSelector = (mode: "on" | "off"): string =>
  `html[data-intervu-mode="${mode}"]`;

/** The artifact iframe, located in the chrome by its data hook. */
export const artifactFrame = (page: Page): FrameLocator =>
  page.frameLocator("[data-artifact]");

/** Open a session for an artifact at `path` and navigate to its chrome page. */
export const openPath = async (
  page: Page,
  request: APIRequestContext,
  baseURL: string,
  path: string,
): Promise<string> => {
  const response = await request.post(`${baseURL}/sessions`, {
    data: { path },
  });
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  const key =
    typeof body === "object" &&
    body !== null &&
    "key" in body &&
    typeof body.key === "string"
      ? body.key
      : null;
  expect(key).not.toBeNull();
  await page.goto(`${baseURL}/s/${key}`);
  // The SDK has loaded inside the iframe once it has stamped the mode attribute.
  await artifactFrame(page).locator(modeSelector("off")).waitFor();
  return key ?? "";
};

/** Open a session for the committed fixture and navigate to its chrome page. */
export const openArtifact = async (
  page: Page,
  request: APIRequestContext,
  baseURL: string,
): Promise<void> => {
  await openPath(page, request, baseURL, fixturePath);
};

/**
 * Write a throwaway artifact to a fresh temp directory and return its realpath -
 * a unique path means a unique Session, so file-editing specs stay isolated and
 * never touch the committed fixture. Includes a clickable element for annotation.
 */
export const tempArtifact = (headline: string): string => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-e2e-art-"));
  const file = nodePath.join(dir, "artifact.html");
  fs.writeFileSync(file, artifactHtml(headline));
  return fs.realpathSync(file);
};

/** The throwaway artifact's HTML, parameterized by its headline text. */
export const artifactHtml = (headline: string): string =>
  `<!doctype html><html><head><title>temp artifact</title></head><body><h1 id="headline">${headline}</h1><button id="native-btn" type="button">Native</button></body></html>`;

/** Turn Annotate-mode on and wait for the SDK to reflect it inside the iframe. */
export const armAnnotate = async (page: Page): Promise<void> => {
  const toggle = page.locator("[data-annotate-toggle]");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await artifactFrame(page).locator(modeSelector("on")).waitFor();
};

/** A non-null bounding box for `locator`, failing the test if it has none. */
const boxOf = async (
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const box = await locator.boundingBox();
  expect(box, "expected the element to have a bounding box").not.toBeNull();
  if (box === null) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return box;
};

/** Drag-select the text of `locator` with a raw mouse gesture. */
export const dragSelectText = async (
  page: Page,
  locator: Locator,
): Promise<void> => {
  const box = await boxOf(locator);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 6 });
  await page.mouse.up();
};
