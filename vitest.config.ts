import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
        // The local ONNX model layer is integration-only: exercising it pulls
        // ~0.5 GB of model weights, so it is left to opt-in integration runs and
        // excluded here to keep the report a map of unit-testable gaps rather
        // than a permanent red block that buries the real ones.
        "src/local/models/**",
        "src/local/ai-mask.ts",
        "src/local/upscale.ts",
        "**/*.d.ts",
      ],
    },
  },
});
