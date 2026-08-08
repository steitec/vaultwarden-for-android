import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // One shared server, one shared account: parallel files would race on
    // registration and on the sync snapshot.
    fileParallelism: false,
  },
});
