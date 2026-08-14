#!/usr/bin/env node
// Entry point for `npm run build`.
//
// Builds every extension entry point that currently exists on disk into a
// self-contained classic script under dist/, then copies the manifest. See
// scripts/build-classic-entry.mjs for why each entry is built as its own
// independent Rollup graph instead of one multi-entry Vite build.
import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildClassicEntry } from "./build-classic-entry.mjs";
import { ENTRIES } from "./entries.mjs";

const root = process.cwd();
const outDir = resolve(root, "dist");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const present = ENTRIES.filter((entry) => existsSync(resolve(root, entry.input)));

if (present.length === 0) {
  throw new Error(
    "No known entry points found under src/ (checked: " +
      ENTRIES.map((e) => e.input).join(", ") +
      "). Nothing to build.",
  );
}

for (const entry of present) {
  await buildClassicEntry({ ...entry, root, outDir: "dist" });
}

copyFileSync(resolve(root, "src/manifest.json"), resolve(outDir, "manifest.json"));

// The popup's static assets. Only the .ts entry is built; the document that
// loads it and its stylesheet have to be copied, or browser_action opens a
// 404 with no script in it.
copyFileSync(resolve(root, "src/popup/popup.html"), resolve(outDir, "popup.html"));
copyFileSync(resolve(root, "src/popup/popup.css"), resolve(outDir, "popup.css"));

// Both sizes the manifest names, flattened to dist/ root because the manifest
// references them as bare filenames. A missing icon is only a `web-ext lint`
// warning, not a build error, so it would otherwise reach AMO unnoticed.
copyFileSync(resolve(root, "src/icons/icon-48.png"), resolve(outDir, "icon-48.png"));
copyFileSync(resolve(root, "src/icons/icon-96.png"), resolve(outDir, "icon-96.png"));

console.log(
  `Built ${present.length} entry point(s): ${present.map((e) => e.name).join(", ")}`,
);
