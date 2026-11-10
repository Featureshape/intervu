import { expect, test } from "@playwright/test";
import { fixtureAppUrl, noDaemonAppUrl } from "./support.ts";

/**
 * The `intervu/vite` relay: the dev server forwards `/__intervu/*` to the
 * loopback daemon for the app's own origin and nobody else. A page on another
 * origin, a cross-site fetch, or a rebound foreign `Host` is turned away before
 * anything reaches the daemon.
 */

const health = `${fixtureAppUrl}/__intervu/health`;

/** The `{error:{tag}}` the relay answers a refused request with. */
const errorTag = async (response: {
  json: () => Promise<unknown>;
}): Promise<unknown> => {
  const body = await response.json();
  return typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "tag" in body.error
    ? body.error.tag
    : null;
};

test("a same-origin request is relayed to the daemon", async ({ request }) => {
  for (const headers of [{}, { Origin: fixtureAppUrl }]) {
    const response = await request.get(health, { headers });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      version: expect.any(String),
    });
  }
});

test("a request with a foreign Origin is rejected", async ({ request }) => {
  const response = await request.get(health, {
    headers: { Origin: "http://evil.example" },
  });
  expect(response.status()).toBe(403);
  expect(await errorTag(response)).toBe("ForeignOrigin");
});

test("a cross-site fetch is rejected even without an Origin", async ({
  request,
}) => {
  const response = await request.get(health, {
    headers: { "Sec-Fetch-Site": "cross-site" },
  });
  expect(response.status()).toBe(403);
});

test("a foreign Host is rejected, closing DNS rebinding", async ({
  request,
}) => {
  const response = await request.get(health, {
    headers: {
      Host: "evil.example:51991",
      Origin: "http://evil.example:51991",
    },
  });
  expect(response.status()).toBe(403);
});

test("a page on another origin cannot reach the relay", async ({
  page,
  baseURL,
}) => {
  // The daemon's own origin is as foreign to the app as any other site.
  await page.goto(`${baseURL}/health`);
  const relayed = page.waitForResponse(health);
  await page.evaluate(async (url) => {
    await fetch(url, { mode: "no-cors" });
  }, health);
  expect((await relayed).status()).toBe(403);
});

test("a route the page has no use for is not relayed", async ({ request }) => {
  const response = await request.post(`${fixtureAppUrl}/__intervu/sessions`, {
    data: { path: "/etc/hosts" },
  });
  expect(response.status()).toBe(404);
  expect(await errorTag(response)).toBe("RouteNotRelayed");
});

test("a stopped daemon answers as DaemonUnreachable", async ({ request }) => {
  const response = await request.get(`${noDaemonAppUrl}/__intervu/health`);
  expect(response.status()).toBe(502);
  expect(await errorTag(response)).toBe("DaemonUnreachable");
});
