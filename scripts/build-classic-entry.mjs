import { build } from "vite";
import { resolve } from "node:path";

/**
 * Build a single entry point into one fully self-contained CLASSIC script:
 * IIFE format, no code-splitting, no `import`/`export` statements in the
 * emitted file.
 *
 * Why this exists: Firefox loads MV2 `background.scripts` and
 * `content_scripts` as classic (non-module) scripts, not ES modules. MV2 has
 * no `background.type: "module"` escape hatch, and content scripts cannot be
 * modules either. A single Rollup build with multiple entry points will,
 * once any module is shared between two entries, extract that module into a
 * separate chunk and emit `import { ... } from "./chunk.js"` in the entry
 * files — a SyntaxError at extension load time in a classic script context.
 *
 * The fix is structural: run one independent Rollup build per entry point
 * (via Vite's `build()` JS API in library mode, format "iife"). Because each
 * build only ever sees a single entry, Rollup has no second entry to diff
 * against and therefore nothing to extract into a shared chunk — the entry
 * and everything it statically imports are inlined into one file.
 * `inlineDynamicImports: true` closes the same gap for any dynamic
 * `import()` calls within that one entry's own graph.
 */
export async function buildClassicEntry({
  name,
  input,
  globalName,
  root = process.cwd(),
  outDir = "dist",
}) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: false,
      target: "firefox121",
      minify: false,
      lib: {
        entry: resolve(root, input),
        formats: ["iife"],
        name: globalName,
        fileName: () => `${name}.js`,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });
}
