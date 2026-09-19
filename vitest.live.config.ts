import { configDefaults, defineConfig } from "vitest/config";

// The live lane: the pinned local models and the real OpenAI API, run only by
// npm run test:full. Files run one at a time because they share the model
// cache, spend money, and wait on the network.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    exclude: configDefaults.exclude,
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 60 * 60_000,
  },
});
