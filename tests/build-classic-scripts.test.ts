import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { buildClassicEntry } from "../scripts/build-classic-entry.mjs";

// Firefox loads MV2 `background.scripts` and `content_scripts` as CLASSIC
// scripts, not ES modules. `import`/`export` in those files is a
// SyntaxError at extension load time, and MV2 has no `background.type:
// "module"` escape hatch.
//
// A single Rollup build with multiple entry points only starts emitting
// `import`/`export` once two entries share a module -- with today's single
// `background` entry, nothing splits, so a check against the real build
// alone would pass vacuously even if the build were still broken. This
// suite constructs the actual failure scenario (two entries sharing a
// module) against the same build primitive scripts/build.mjs uses
// (buildClassicEntry), so it will fail again if a future change
// (e.g. reverting to one multi-entry `vite build`) reintroduces splitting
// when Task 11 / Task 14 add src/content/autofill.ts and src/popup/popup.ts.
const ESM_SYNTAX = /\b(import|export)\b/;

describe("classic script build (regression guard for MV2 background/content scripts)", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps two entries that share a module fully self-contained and import/export-free", async () => {
    workDir = mkdtempSync(join(tmpdir(), "vw-build-classic-"));
    const srcDir = join(workDir, "src");
    mkdirSync(srcDir, { recursive: true });

    // A module shared by two entry points -- the exact shape that later
    // triggers Rollup's chunk extraction in a naive multi-entry build.
    writeFileSync(
      join(srcDir, "shared.ts"),
      `export const SHARED_MARKER = "shared-value-from-common-module";\n`,
    );
    writeFileSync(
      join(srcDir, "entryA.ts"),
      `import { SHARED_MARKER } from "./shared";\n` +
        `(globalThis as any).__ENTRY_A_RESULT__ = SHARED_MARKER + "-A";\n`,
    );
    writeFileSync(
      join(srcDir, "entryB.ts"),
      `import { SHARED_MARKER } from "./shared";\n` +
        `(globalThis as any).__ENTRY_B_RESULT__ = SHARED_MARKER + "-B";\n`,
    );

    const outDir = join(workDir, "dist");
    mkdirSync(outDir, { recursive: true });

    // Each call is an independent Rollup build (this is the fix): neither
    // build knows the other entry exists, so there is no second entry to
    // diff against and nothing to extract into a shared chunk.
    await buildClassicEntry({
      name: "entryA",
      input: "src/entryA.ts",
      globalName: "TestEntryA",
      root: workDir,
      outDir: "dist",
    });
    await buildClassicEntry({
      name: "entryB",
      input: "src/entryB.ts",
      globalName: "TestEntryB",
      root: workDir,
      outDir: "dist",
    });

    const entryASource = readFileSync(join(outDir, "entryA.js"), "utf8");
    const entryBSource = readFileSync(join(outDir, "entryB.js"), "utf8");

    expect(entryASource).not.toMatch(ESM_SYNTAX);
    expect(entryBSource).not.toMatch(ESM_SYNTAX);

    // Syntactic absence of import/export isn't proof by itself -- prove
    // each file is *actually* self-contained by running it, alone, as a
    // classic script with no module loader and no access to the other
    // entry's output or a shared chunk file. If SHARED_MARKER had been
    // extracted into a separate chunk, this would throw or leave the
    // marker undefined.
    const sandboxA: Record<string, unknown> = {};
    vm.createContext(sandboxA);
    expect(() => vm.runInContext(entryASource, sandboxA)).not.toThrow();
    expect(sandboxA.__ENTRY_A_RESULT__).toBe("shared-value-from-common-module-A");

    const sandboxB: Record<string, unknown> = {};
    vm.createContext(sandboxB);
    expect(() => vm.runInContext(entryBSource, sandboxB)).not.toThrow();
    expect(sandboxB.__ENTRY_B_RESULT__).toBe("shared-value-from-common-module-B");
  });

  it("produces import/export-free output for the real background entry", async () => {
    // Smoke test against the actual production entry, in addition to (not
    // instead of) the meaningful multi-entry case above. Builds into an
    // isolated temp dir so it doesn't depend on dist/ already existing.
    workDir = mkdtempSync(join(tmpdir(), "vw-build-real-"));
    const outDir = join(workDir, "dist");
    mkdirSync(outDir, { recursive: true });

    await buildClassicEntry({
      name: "background",
      input: "src/background/index.ts",
      globalName: "VaultwardenBackground",
      root: process.cwd(),
      outDir,
    });

    const source = readFileSync(join(outDir, "background.js"), "utf8");
    expect(source).not.toMatch(ESM_SYNTAX);

    // The background entry registers its onMessage listener and starts the
    // controller at load time, so the sandbox has to provide the
    // WebExtension globals it legitimately depends on -- exactly the ones
    // Firefox itself provides to a background script. This is the harness
    // becoming more realistic, not the assertion becoming weaker: the
    // "runs as a classic script without throwing" check now exercises the
    // entry's real top-level work (module graph fully inlined, controller
    // constructed, listener registered) instead of an empty module.
    const addListener = vi.fn();
    const sandbox = {
      browser: {
        runtime: { id: "test@example", onMessage: { addListener } },
        storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      },
    };
    expect(() => vm.runInContext(source, vm.createContext(sandbox))).not.toThrow();
    expect(addListener).toHaveBeenCalledTimes(1);
  });
});
