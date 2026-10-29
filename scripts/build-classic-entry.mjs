import { build } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A `/*! ... *\/` banner with the LICENSE file of each bundled package, so
 * the notice MIT requires travels with the built file (BACKLOG 3.1). It is
 * prepended after the build: Vite's final transpile step in library mode
 * drops a Rollup `output.banner`.
 */
function licenceBanner(root, packages) {
  return packages
    .map((pkg) => {
      const text = readFileSync(resolve(root, "node_modules", pkg, "LICENSE"), "utf8");
      const body = text.trim().split("\n").map((l) => ` * ${l}`.trimEnd()).join("\n");
      return `/*! Bundled: ${pkg}\n *\n${body}\n */`;
    })
    .join("\n");
}

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
 * `codeSplitting: false` closes the same gap for any dynamic
 * `import()` calls within that one entry's own graph.
 */
export async function buildClassicEntry({
  name,
  input,
  globalName,
  root = process.cwd(),
  outDir = "dist",
  licences = [],
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
      rolldownOptions: {
        output: {
          codeSplitting: false,
          // Rolldown's default ("auto") drops the directive from an IIFE,
          // which would run the whole add-on in sloppy mode.
          strict: true,
          // Source comments only make the shipped file larger. Legal ones
          // stay; the licence banner is prepended below anyway.
          comments: { legal: true, annotation: false, jsdoc: false },
        },
      },
    },
  });

  if (licences.length > 0) {
    const file = resolve(root, outDir, `${name}.js`);
    writeFileSync(file, `${licenceBanner(root, licences)}\n${readFileSync(file, "utf8")}`);
  }
}
