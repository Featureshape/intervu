import { chmodSync } from "node:fs";

/**
 * Bundle the CLI into a single executable ESM file at `dist/intervu`.
 *
 * The bundle targets Bun because the entrypoint wires the Bun platform services
 * (`BunServices` / `BunRuntime`), so the emitted file carries a `bun` shebang
 * and the executable bit.
 */
const outPath = "dist/intervu";

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  target: "bun",
  format: "esm",
});

if (!result.success) {
  for (const message of result.logs) {
    console.error(message);
  }
  process.exit(1);
}

const artifact = result.outputs[0];
if (artifact === undefined) {
  console.error("build produced no output artifact");
  process.exit(1);
}

const code = await artifact.text();
await Bun.write(outPath, `#!/usr/bin/env bun\n${code}`);
chmodSync(outPath, 0o755);

console.error(`built ${outPath}`);

/**
 * Bundle the `intervu/vite` plugin into `dist/vite.js`. Vite loads it on Node,
 * so it targets Node and carries no runtime dependency: the in-page overlay is
 * inlined from the baked `generated/overlayAsset.ts`, and `vite` is only a type.
 * Its declaration is written by hand because `Bun.build` emits no types.
 */
const pluginOutPath = "dist/vite.js";

const pluginResult = await Bun.build({
  entrypoints: ["src/vite/plugin.ts"],
  target: "node",
  format: "esm",
});

const pluginArtifact = pluginResult.success
  ? pluginResult.outputs[0]
  : undefined;
if (pluginArtifact === undefined) {
  for (const message of pluginResult.logs) {
    console.error(message);
  }
  console.error("build produced no vite plugin output");
  process.exit(1);
}

await Bun.write(pluginOutPath, await pluginArtifact.text());
await Bun.write(
  "dist/vite.d.ts",
  `import type { Plugin } from "vite";

/** The Vite plugin that wires intervu's URL mode into the dev server. */
export declare const intervu: () => Plugin;
export default intervu;
`,
);

console.error(`built ${pluginOutPath}`);
