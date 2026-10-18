import { configDefaults, defineConfig } from "vitest/config";

// The app root's own tests. The SDK's suite runs in its package
// (npm test -w gptimgsdk), so packages/ is excluded here.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "packages/**"],
  },
});
