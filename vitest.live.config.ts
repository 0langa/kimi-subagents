import { defineConfig } from "vitest/config";

// Live suite: drives the installed Kimi Code binary through real ACP jobs.
// Run with `npm run test:live`; excluded from the deterministic suite.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000
  }
});
