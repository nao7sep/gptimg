import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Two projects, so `vitest` at the repository root runs both suites and a
    // path under either tests folder resolves: the app's, configured here, and
    // the SDK's, which keeps its own configuration in sdk/ as it would in a
    // repository of its own.
    projects: [
      {
        test: {
          name: "app",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          setupFiles: ["tests/setup/rendered-keys.ts"],
          // After-hooks in the order registered, so the rendered-key gate looks before a file's cleanup empties the page.
          sequence: { hooks: "list" },
          exclude: [...configDefaults.exclude, "sdk/**", "tests/live/**"],
        },
      },
      "./sdk",
    ],
  },
});
