import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The integration suite needs a Docker container on 127.0.0.1:18080 and
    // is run by `npm run test:integration`. `exclude` REPLACES vitest's
    // defaults, so node_modules has to be spelled out again here.
    exclude: ["tests/integration/**", "**/node_modules/**"],
    environmentMatchGlobs: [
      ["tests/content/**", "jsdom"],
      ["tests/popup/**", "jsdom"],
    ],
  },
});
