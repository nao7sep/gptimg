import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sdk",
    // The live lane spends money and downloads models; only npm run test:full
    // runs it, through vitest.live.config.ts.
    exclude: [...configDefaults.exclude, "tests/live/**"],
    coverage: {
      // V8's native coverage — the installed provider, no instrumentation step.
      // `include` lists every source file so the report flags logic no test
      // reaches, not just a score for the code that is reached.
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts", // public barrel: re-exports only
        "src/types.ts", // type declarations only, no runtime code
        "**/*.d.ts",
      ],
    },
  },
});
