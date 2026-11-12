import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test } from "@playwright/test";
import type { JsonValue } from "@toon-format/toon";
import { browserRecorder, fieldOf, runCliRaw } from "./cli.ts";
import { artifactHtml } from "./support.ts";

/**
 * The idle TTL end to end, against a daemon with its own state dir and a
 * pinned spare port: a Session whose persisted `lastActivityAt` is older
 * than the TTL is absent from bare `intervu`, swept to `ended` by the
 * daemon on start, and resurrected by re-open - while a state file from
 * before the field loads with it defaulted to the load time, so nothing
 * expires on the first read after an upgrade.
 *
 * The spec owns its daemon; it runs in order.
 */

test.describe.configure({ mode: "serial" });

/** A pinned spare port: the spec's daemon must not join the shared range. */
const ttlPort = 51970;

const stateDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-ttl-"));
const env = { INTERVU_STATE_DIR: stateDir, INTERVU_PORT: String(ttlPort) };

/** The Session key of `handle`: 16 hex chars of its SHA-256 (ADR 0001). */
const keyOf = (handle: string): string =>
  createHash("sha256").update(handle).digest("hex").slice(0, 16);

/** A committed-looking artifact in its own temp dir, realpath-resolved. */
const artifactAt = (name: string): string => {
  const file = nodePath.join(stateDir, name);
  fs.writeFileSync(file, artifactHtml(name));
  return fs.realpathSync(file);
};

const expiredArtifact = artifactAt("expired.html");
const legacyArtifact = artifactAt("legacy.html");

test.beforeAll(() => {
  const dayMs = 24 * 60 * 60 * 1000;
  fs.writeFileSync(
    nodePath.join(stateDir, "state.json"),
    JSON.stringify({
      version: 1,
      sessions: [
        // Idle past the default 24h TTL.
        {
          key: keyOf(expiredArtifact),
          path: expiredArtifact,
          status: "open",
          kind: "artifact",
          lastActivityAt: Date.now() - dayMs - 60 * 60 * 1000,
        },
        // Written by an older version: no lastActivityAt at all.
        {
          key: keyOf(legacyArtifact),
          path: legacyArtifact,
          status: "open",
          kind: "artifact",
        },
      ],
    }),
  );
});

test.afterAll(async () => {
  await runCliRaw(["stop"], browserRecorder(), env);
});

test("bare intervu omits the expired Session and keeps the legacy one", async () => {
  const run = await runCliRaw([], browserRecorder(), env);
  expect(run.exitCode).toBe(0);
  const sessions = fieldOf(run.output, "sessions");
  const paths = (Array.isArray(sessions) ? sessions : []).map((session) =>
    fieldOf(session, "path"),
  );
  expect(paths).not.toContain(expiredArtifact);
  // The old-format Session defaulted its activity to the load time, so the
  // first read after an upgrade expires nothing.
  expect(paths).toContain(legacyArtifact);
});

test("the daemon sweeps the expired Session to ended on start", async () => {
  // Opening an unrelated Session spawns this state dir's daemon, whose
  // start-up sweep tidies the expired one.
  const opened = await runCliRaw(
    [artifactAt("fresh.html")],
    browserRecorder(),
    env,
  );
  expect(opened.exitCode).toBe(0);

  await expect
    .poll(() => {
      const state: JsonValue = JSON.parse(
        fs.readFileSync(nodePath.join(stateDir, "state.json"), "utf8"),
      );
      const sessions = fieldOf(state, "sessions");
      const row = (Array.isArray(sessions) ? sessions : []).find(
        (session) => fieldOf(session, "path") === expiredArtifact,
      );
      return fieldOf(row ?? null, "status");
    })
    .toBe("ended");
});

test("re-opening the handle resurrects the swept Session", async () => {
  const run = await runCliRaw([expiredArtifact], browserRecorder(), env);
  expect(run.exitCode).toBe(0);
  expect(fieldOf(run.output, "status")).toBe("open");
  expect(fieldOf(run.output, "path")).toBe(expiredArtifact);
});
