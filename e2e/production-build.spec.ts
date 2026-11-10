import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { fixtureAppDir, fixtureAppUrl, viteBin } from "./support.ts";

/**
 * URL mode never ships: the `intervu/vite` plugin is dev-server only, so a
 * production `vite build` of the fixture app holds no overlay, no relay script
 * tag and no `data-intervu-*` attribute. The `data-intervu` fingerprint also
 * covers the `data-intervu-src` stamp of the JSX source transform.
 */

/** Strings only intervu's dev-time code puts into an app. */
const relayFingerprint = "/__intervu/";
const overlayFingerprints = [
  "intervu-overlay",
  "data-intervu",
  "intervu: no agent",
];
const intervuFingerprints = [relayFingerprint, ...overlayFingerprints];

/** The fingerprints that occur in `text`. */
const fingerprintsIn = (text: string): string[] =>
  intervuFingerprints.filter((fingerprint) => text.includes(fingerprint));

/** Every file under `dir`, recursively, keyed by its path relative to `dir`. */
const readTree = async (dir: string): Promise<Map<string, string>> => {
  const entries = await fs.readdir(dir, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  return new Map(
    await Promise.all(
      files.map(
        async (file) =>
          [path.relative(dir, file), await fs.readFile(file, "utf8")] as const,
      ),
    ),
  );
};

test("vite build output contains no intervu code", async ({ request }) => {
  test.setTimeout(120_000);

  // The dev server does carry every fingerprint, so the build search below
  // cannot pass by looking for strings intervu never emits.
  const page = await request.get(fixtureAppUrl);
  expect(page.ok()).toBe(true);
  expect(fingerprintsIn(await page.text())).toContain(relayFingerprint);
  const overlay = await request.get(`${fixtureAppUrl}/__intervu/overlay.js`);
  expect(overlay.ok()).toBe(true);
  expect(fingerprintsIn(await overlay.text())).toEqual(
    expect.arrayContaining(overlayFingerprints),
  );

  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "intervu-e2e-vite-build-"),
  );
  try {
    await promisify(execFile)(
      process.execPath,
      [
        viteBin,
        "build",
        "--outDir",
        outDir,
        "--emptyOutDir",
        "--logLevel=warn",
      ],
      { cwd: fixtureAppDir },
    );
    const output = await readTree(outDir);

    const found = [...output].flatMap(([file, text]) =>
      fingerprintsIn(text).map((fingerprint) => `${file}: ${fingerprint}`),
    );
    expect(found).toEqual([]);

    // The built app is still the fixture app, so the search read real output.
    expect(output.get("index.html")).toContain('<div id="root"></div>');
    const bundle = [...output]
      .filter(([file]) => file.endsWith(".js"))
      .map(([, text]) => text)
      .join("\n");
    expect(bundle).toContain("Fixture app");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
