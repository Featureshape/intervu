import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bakedOverlayJs } from "../generated/overlayAsset.ts";

/**
 * The in-page overlay script the plugin serves to the app, built the way the
 * daemon's browser assets are (ADR 0007): the published plugin serves the copy
 * `scripts/build-browser.ts` baked into `generated/overlayAsset.ts`; running
 * from the source tree, it rebuilds `src/overlay/entry.ts` with Bun on dev
 * server start, so an edit is live on the next restart. The plugin itself runs
 * on Node inside Vite, so the rebuild shells out to the `bun` CLI instead of
 * calling `Bun.build`.
 */

const overlayEntry = fileURLToPath(
  new URL("../overlay/entry.ts", import.meta.url),
);

/** The overlay bundle, or why it could not be produced. */
export type OverlayBuild =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: string };

/** The `bun build` arguments that bundle the overlay as a self-running IIFE. */
const buildArgs = [
  "build",
  overlayEntry,
  "--target=browser",
  "--format=iife",
  "--minify",
];

/** Bundle the overlay from source, or explain why it could not be built. */
export const buildOverlayFromSource = (): Promise<OverlayBuild> =>
  new Promise((resolve) => {
    execFile(
      "bun",
      buildArgs,
      { maxBuffer: 16 * 1024 * 1024 },
      (failure, stdout, stderr) => {
        resolve(
          failure === null
            ? { ok: true, code: stdout }
            : {
                ok: false,
                reason: `bun ${buildArgs.join(" ")} failed: ${stderr || failure.message}`,
              },
        );
      },
    );
  });

/**
 * The overlay script to serve: rebuilt when the source entry sits next to this
 * module (the repo), baked otherwise (the published package).
 */
export const loadOverlayJs = (): Promise<OverlayBuild> =>
  existsSync(overlayEntry)
    ? buildOverlayFromSource()
    : Promise.resolve({ ok: true, code: bakedOverlayJs });
