// The app bundles the SDK from source, so its package must carry every runtime
// dependency the SDK loads (sdk-conventions, *The app carries the SDK*), at the
// same range, or a packaged app resolves another version or none. The native
// ones stay outside the bundle and ship in the app's dependencies; the rest are
// bundled, so they are build inputs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

describe("the SDK's runtime dependencies", () => {
  it("are declared by the app at the SDK's own ranges", () => {
    const app = read("../package.json");
    const sdk = read("../sdk/package.json");
    const declared = { ...app.devDependencies, ...app.dependencies };
    const missing = Object.entries(sdk.dependencies ?? {}).filter(([name, range]) => declared[name] !== range);
    expect(missing.map(([name, range]) => `${name}@${range} (app: ${declared[name] ?? "none"})`)).toEqual([]);
    for (const native of ["sharp", "onnxruntime-node"]) expect(app.dependencies?.[native], native).toBe(sdk.dependencies?.[native]);
  });
});
