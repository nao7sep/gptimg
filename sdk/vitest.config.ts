import { configDefaults, defineConfig } from "vitest/config";

// Every test worker loads sharp, whose libvips pool is otherwise one thread per core
// in each worker: with a worker per core that is cores × cores threads, and CPU-heavy
// tests slow several-fold when the suite runs together. One libvips thread per worker
// keeps a test's time what it is alone; workers already use every core. Set before any
// worker starts, so they and the processes tests spawn inherit it.
process.env.VIPS_CONCURRENCY ??= "1";


export default defineConfig({
  test: {
    name: "sdk",
    // Tests carry no timeouts: each waits for the result or event it needs.
    testTimeout: 0,
    hookTimeout: 0,
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
