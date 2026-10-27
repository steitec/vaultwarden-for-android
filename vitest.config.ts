import { defineConfig } from "vitest/config";

// Content-script and popup tests need a DOM; everything else runs in node.
// (vitest 4 removed `environmentMatchGlobs`, so the split is done with projects.)
const DOM_TESTS = ["tests/content/**/*.test.ts", "tests/popup/**/*.test.ts"];

// The integration suite needs a Docker container on 127.0.0.1:18080 and
// is run by `npm run test:integration`. `exclude` REPLACES vitest's
// defaults, so node_modules has to be spelled out again here.
const EXCLUDE = ["tests/integration/**", "**/node_modules/**"];

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: [...EXCLUDE, ...DOM_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: DOM_TESTS,
          exclude: EXCLUDE,
        },
      },
    ],
  },
});
