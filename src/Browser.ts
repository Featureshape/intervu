import { Effect, Option } from "effect";

/**
 * Open a browser tab at `url`, detached so the spawned process outlives this
 * CLI. This is the human's entry into the review surface: the chrome at the
 * per-session `/s/:key` route, or the running app itself with `--open`.
 *
 * `browser` (from `INTERVU_BROWSER`) names the program to run with the URL as
 * its only argument; `None` opens the OS default browser.
 */
export const openTab = (
  url: string,
  browser: Option.Option<string>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const command = Option.match(browser, {
      onSome: (program) => [program, url],
      onNone: () =>
        process.platform === "darwin"
          ? ["open", url]
          : process.platform === "win32"
            ? ["cmd", "/c", "start", "", url]
            : ["xdg-open", url],
    });
    const child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
  });
