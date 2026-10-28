import { defineConfig } from "vitest/config";

// The app's paid lane, apart from the ordinary suite: one file at a time, and
// only from `npm run test:live` (part of `test:full`).
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    fileParallelism: false,
    // No runner timeouts: each paid call is bounded by the product's own network deadlines.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
