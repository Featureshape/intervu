import * as http from "node:http";
import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";

/**
 * The scheme/port warning: `intervu http://<host>:443` names an origin no
 * browser will ever report (a browser on TLS port 443 reports `https://` with
 * no port), so the CLI warns and suggests the right origin while the Session
 * still opens. A plain HTTP fixture binds 443 - unprivileged on macOS; where
 * the bind is refused, the spec skips rather than fails.
 */

test("intervu http://localhost:443 warns and suggests the https origin", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(443, () => resolve(true));
  });
  test.skip(!bound, "port 443 is not bindable here");

  try {
    const run = await runCli(["http://localhost:443"], browserRecorder());
    expect(run.exitCode).toBe(0);
    expect(fieldOf(run.output, "status")).toBe("open");
    expect(fieldOf(run.output, "origin")).toBe("http://localhost:443");
    const warning = String(fieldOf(run.output, "warning"));
    expect(warning).toContain("no browser will report");
    expect(warning).toContain("intervu https://localhost");
  } finally {
    await runCli(["end", "http://localhost:443"], browserRecorder());
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
});
