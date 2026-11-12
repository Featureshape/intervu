import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";
import { VitePluginBuildError } from "./Errors.ts";
import { bakedVitePluginJs } from "./generated/vitePluginAsset.ts";

/**
 * The `intervu/vite` plugin as one dependency-free ESM file - the exact
 * bundle published as `dist/vite.js` - which `intervu setup vite` writes
 * into a project with no package manager and no network (ADR 0007's carry
 * mechanism). The shipped binary serves the copy `scripts/build-browser.ts`
 * baked into `generated/vitePluginAsset.ts`; running from source, the dev
 * layer rebuilds the bundle with Bun so an edit is live on the next run.
 * The build runs lazily, at use, so a broken dev build fails `setup vite`
 * alone rather than every command's layer.
 */

const pluginEntry = fileURLToPath(new URL("vite/plugin.ts", import.meta.url));

/** Bundle the plugin from source, as `scripts/build.ts` does for dist. */
const buildFromSource: Effect.Effect<string, VitePluginBuildError> =
  Effect.callback((resume) => {
    execFile(
      "bun",
      ["build", pluginEntry, "--target=node", "--format=esm"],
      { maxBuffer: 16 * 1024 * 1024 },
      (failure, stdout, stderr) => {
        resume(
          failure === null
            ? Effect.succeed(stdout)
            : Effect.fail(
                new VitePluginBuildError({
                  reason: stderr === "" ? failure.message : stderr,
                }),
              ),
        );
      },
    );
  });

export interface VitePluginAssetShape {
  readonly js: Effect.Effect<string, VitePluginBuildError>;
}

export class VitePluginAsset extends Context.Service<
  VitePluginAsset,
  VitePluginAssetShape
>()("@intervu/VitePluginAsset") {
  /** The bundle frozen by `scripts/build-browser.ts`, as the binary carries it. */
  static readonly bakedLayer = Layer.succeed(VitePluginAsset, {
    js: Effect.succeed(bakedVitePluginJs),
  });

  /**
   * Dev rebuilds the bundle from source on each use; the shipped binary (no
   * source tree) falls back to the baked string. The branch is the presence
   * of the source entry next to this module, so no env flag is needed.
   */
  static readonly layer = Layer.succeed(VitePluginAsset, {
    js: existsSync(pluginEntry)
      ? buildFromSource
      : Effect.succeed(bakedVitePluginJs),
  });
}
