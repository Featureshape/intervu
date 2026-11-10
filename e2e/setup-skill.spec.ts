import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { expect, test } from "@playwright/test";
import { browserRecorder, fieldOf, runCli } from "./cli.ts";

/**
 * The Skill `intervu setup` writes is how a fresh agent learns URL mode
 * (behaviour 25): how to open a Session on a running app's URL, how to add the
 * `intervu/vite` plugin to `vite.config.ts`, and what an annotation's `source`
 * and `pageUrl` mean. The CLI runs for real into a throwaway project, and the
 * spec reads back the file it wrote.
 */

/** The text of the Skill's section headed `heading`, up to the next heading of
 * the same or a higher level. */
const section = (markdown: string, heading: string): string => {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  expect(start, `expected the heading "${heading}"`).toBeGreaterThanOrEqual(0);
  const level = heading.indexOf(" ");
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+ /.test(line) && line.indexOf(" ") <= level,
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
};

test("intervu setup writes a Skill that teaches URL mode", async () => {
  const project = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-e2e-setup-")),
  );
  // `setup` refuses unless a bare `intervu` resolves on PATH, so put a stub
  // there rather than depend on a global install.
  const bin = nodePath.join(project, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(nodePath.join(bin, "intervu"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  const run = await runCli(
    ["setup", "--project", "--skill-only"],
    browserRecorder(),
    {
      cwd: project,
      env: { PATH: `${bin}${nodePath.delimiter}${process.env.PATH ?? ""}` },
    },
  );

  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  const skillFile = nodePath.join(
    project,
    ".claude",
    "skills",
    "intervu",
    "SKILL.md",
  );
  expect(fieldOf(run.output, "skill")).toEqual({
    action: "installed",
    path: skillFile,
  });

  const skill = fs.readFileSync(skillFile, "utf8");
  const urlMode = section(skill, "## Reviewing a running app (URL mode)");

  const plugin = section(urlMode, "### Add the plugin once");
  expect(plugin).toContain("vite.config.ts");
  expect(plugin).toContain("intervu/vite");
  expect(plugin).toContain("intervu()");

  const opening = section(urlMode, "### Open a review on the app's URL");
  expect(opening).toContain("intervu http://localhost:5173");
  expect(opening).toContain("intervu poll http://localhost:5173");
  expect(urlMode).toContain("AppUnreachable");

  const fields = section(urlMode, "### What `source` and `pageUrl` mean");
  expect(fields).toContain("`source`");
  expect(fields).toContain("file:line:col");
  expect(fields).toContain("`pageUrl`");
});
