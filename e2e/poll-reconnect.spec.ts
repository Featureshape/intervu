import { expect, test } from "@playwright/test";
import type { JsonValue } from "@toon-format/toon";
import { browserRecorder, fieldOf, runCliRaw } from "./cli.ts";
import { type DroppingProxy, startDroppingProxy } from "./droppingProxy.ts";
import { daemonPort, daemonStateDir } from "./support.ts";

/**
 * Poll resilience is client-side reconnect: through a proxy that cuts idle
 * connections every couple of seconds, a single `intervu poll <url>` with no
 * `--timeout` outlives several forced cuts and still returns the Feedback
 * sent after them - the agent never loops `--timeout 240` by hand again.
 */

test.describe.configure({ mode: "serial" });

const proxyPort = 52021;
/** An origin unique to this spec, so no other session flow touches it. */
const origin = "http://reconnect.example:4173";

let proxy: DroppingProxy | undefined;

test.beforeAll(async () => {
  proxy = await startDroppingProxy({
    port: proxyPort,
    targetPort: daemonPort,
    idleMs: 1_500,
  });
});

test.afterAll(async () => {
  await proxy?.close();
});

test("one poll outlives three connection cuts and returns the late Feedback", async ({
  request,
}) => {
  test.setTimeout(60_000);

  // A Session for the origin, opened directly on the daemon (no app probe).
  const opened = await request.post("/sessions", {
    data: { path: origin, kind: "app" },
  });
  expect(opened.ok()).toBe(true);
  const body: JsonValue = await opened.json();
  const key = String(fieldOf(body, "key"));

  // The CLI reaches the daemon only through the dropping proxy.
  const env = {
    INTERVU_PORT: String(proxyPort),
    INTERVU_STATE_DIR: daemonStateDir,
  };
  const polling = runCliRaw(["poll", origin], browserRecorder(), env);

  // Three cuts before any Feedback exists; each one would have killed the
  // old poll outright.
  await expect
    .poll(() => proxy?.cuts() ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(3);

  const sent = await request.post(`/s/${key}/feedback`, {
    data: {
      message: "survived the cuts",
      annotations: [],
      domSnapshot: "<html><body>late</body></html>",
    },
  });
  expect(sent.ok()).toBe(true);

  const run = await polling;
  expect(run.exitCode).toBe(0);
  const feedback = fieldOf(run.output, "feedback");
  expect(Array.isArray(feedback) ? feedback : []).toHaveLength(1);
  expect(
    fieldOf(Array.isArray(feedback) ? (feedback[0] ?? null) : null, "message"),
  ).toBe("survived the cuts");
});

test("the drop becomes a structured error only when the daemon is gone", async () => {
  // A proxy to a port where nothing listens: health never answers, so the
  // re-issue loop stops with a structured DaemonNotRunning instead of
  // retrying forever.
  const deadProxy = await startDroppingProxy({
    port: 52022,
    targetPort: 52023,
    idleMs: 1_500,
  });
  try {
    const run = await runCliRaw(["poll", origin], browserRecorder(), {
      INTERVU_PORT: "52022",
      INTERVU_STATE_DIR: daemonStateDir,
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toContain("DaemonNotRunning");
  } finally {
    await deadProxy.close();
  }
});
