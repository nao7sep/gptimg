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
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "sdk/**"],
        },
      },
      "./sdk",
    ],
  },
});
