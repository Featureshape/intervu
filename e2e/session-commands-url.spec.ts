import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";
import { commandsAppUrl, tempArtifact } from "./support.ts";

/**
 * URL mode's agent loop (behaviours 9, 10): bare `intervu` lists the app's
 * Session beside an artifact's, and `poll`, `reply` and `end` act on the
 * origin's Session from any of its routes, printing the TOON shapes they print
 * for a file. Each case runs the same loop on a file and on a URL, so the file
 * run is the control for the URL run. Feedback reaches the queue straight
 * through the daemon's Send route, the one the page's panel posts to.
 *
 * The tests run in order: the Home list expects the app's Session open, and the
 * URL loop ends it.
 */
test.describe.configure({ mode: "default" });

test("bare intervu lists the URL-mode Session beside an artifact Session", async () => {
  const browser = browserRecorder();
  const artifact = tempArtifact("listed beside an app");
  const openedFile = await runCli([artifact], browser);
  const openedApp = await runCli([commandsAppUrl], browser);
  expect(openedFile.exitCode).toBe(0);
  expect(openedApp.exitCode).toBe(0);

  const home = await runCli([], browser);

  expect(home.exitCode).toBe(0);
  const sessions = fieldOf(home.output, "sessions");
  expect(sessions).toContainEqual({
    key: fieldOf(openedFile.output, "key"),
    path: artifact,
    status: "open",
  });
  expect(sessions).toContainEqual({
    key: fieldOf(openedApp.output, "key"),
    path: commandsAppUrl,
    status: "open",
  });
  expect(fieldOf(home.output, "help")).toBe(
    "run 'intervu poll <file|url>' to receive feedback, or 'intervu <file|url>' to open another",
  );
});

const cases = [
  {
    kind: "a file",
    target: () => {
      const file = tempArtifact("addressed by its path");
      return { open: file, route: file, name: file, edit: "edit the artifact" };
    },
  },
  {
    kind: "a URL",
    target: () => ({
      open: commandsAppUrl,
      // Any route of the app names the origin's Session.
      route: `${commandsAppUrl}/settings?tab=profile`,
      name: commandsAppUrl,
      edit: "edit the app's source",
    }),
  },
];

for (const { kind, target } of cases) {
  test(`poll, reply and end act on the Session named by ${kind}`, async ({
    request,
    baseURL,
  }) => {
    const browser = browserRecorder();
    const { open, route, name, edit } = target();
    const opened = await runCli([open], browser);
    expect(opened.exitCode).toBe(0);
    const key = fieldOf(opened.output, "key");

    const replied = await runCli(["reply", route, "on it"], browser);
    expect(replied.exitCode).toBe(0);
    expect(replied.output).toEqual({
      posted: true,
      help: `reply posted - keep a poll open with 'intervu poll ${name}'`,
    });

    const sent = await request.post(`${baseURL}/s/${key}/feedback`, {
      data: {
        message: "tighten the header",
        annotations: [],
        domSnapshot: "<html><body>header</body></html>",
      },
    });
    expect(sent.ok()).toBe(true);

    const polled = await runCli(["poll", route, "--timeout", "5"], browser);
    expect(polled.exitCode).toBe(0);
    expect(polled.output).toEqual({
      feedback: [
        {
          message: "tighten the header",
          annotations: [],
          domSnapshotPath: expect.stringMatching(/\.html$/),
        },
      ],
      help: `feedback received - ${edit} or answer with 'intervu reply ${name} "<message>"', then 'intervu poll ${name}' to listen again`,
    });

    const idle = await runCli(["poll", route, "--timeout", "1"], browser);
    expect(idle.exitCode).toBe(0);
    expect(idle.output).toEqual({
      timedOut: true,
      help: `no feedback within the timeout - run 'intervu poll ${name}' to keep listening`,
    });

    const ended = await runCli(["end", route], browser);
    expect(ended.exitCode).toBe(0);
    expect(ended.output).toEqual({
      ended: true,
      help: `review ended - re-run 'intervu ${name}' to reopen`,
    });

    const afterEnd = await runCli(["poll", route], browser);
    expect(afterEnd.exitCode).toBe(0);
    expect(afterEnd.output).toEqual({
      ended: true,
      feedback: [],
      help: `review ended - apply any final feedback above, then stop; re-run 'intervu ${name}' to reopen`,
    });

    const late = await runCli(["reply", route, "too late"], browser);
    expect(late.exitCode).toBe(0);
    expect(late.output).toEqual({
      posted: false,
      help: `nothing posted, the review has ended - re-run 'intervu ${name}' to reopen`,
    });
  });
}
