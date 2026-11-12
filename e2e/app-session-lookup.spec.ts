import { expect, test } from "@playwright/test";
import { browserRecorder, runCli } from "./cli.ts";
import { fixtureAppUrl, fixturePath } from "./support.ts";

/**
 * The daemon's `GET /apps/session`, the lookup the `intervu/vite` relay makes
 * for the in-page overlay: an open `app` Session by origin, `null` for an origin
 * no `app` Session was opened for, and never a create.
 */

test("GET /apps/session finds the app Session open for an origin", async ({
  request,
}) => {
  const run = await runCli([fixtureAppUrl], browserRecorder());
  expect(run.exitCode).toBe(0);

  const response = await request.get("/apps/session", {
    params: { origin: fixtureAppUrl },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    session: {
      key: expect.stringMatching(/^[0-9a-f]{16}$/),
      status: "open",
      // The activity stamp the relay breaks two-daemon ties with.
      lastActivityAt: expect.any(Number),
    },
  });
});

test("GET /apps/session answers null for an origin with no app Session, and opens none", async ({
  request,
}) => {
  const origin = "http://localhost:1";
  const lookup = () => request.get("/apps/session", { params: { origin } });
  expect(await (await lookup()).json()).toEqual({ session: null });
  expect(await (await lookup()).json()).toEqual({ session: null });

  // An artifact's handle is not an app's origin, even when it is open.
  await request.post("/sessions", { data: { path: fixturePath } });
  const artifact = await request.get("/apps/session", {
    params: { origin: fixturePath },
  });
  expect(await artifact.json()).toEqual({ session: null });
});

test("GET /apps/session without an origin is a 400", async ({ request }) => {
  expect((await request.get("/apps/session")).status()).toBe(400);
});
