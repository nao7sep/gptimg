import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// sdk-conventions, Packaging: the source runs as written on Node's own type
// stripping, so a script needs no build and no loader. This loads the package
// by name, through its exports, with the plain runtime that runs these tests.
const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));

describe("the package on plain Node", () => {
  it("loads its entry by name with no loader and nothing on stderr", () => {
    const script = 'const sdk = await import("gptimgsdk"); process.stdout.write(typeof sdk.GptImg + " " + sdk.VERSION);';
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: PACKAGE,
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^function \d+\.\d+\.\d+/);
  });

  it("loads the gptimgsdk/types entry by name, with its code tables", () => {
    const script = 'const t = await import("gptimgsdk/types"); process.stdout.write(Object.keys(t.ERROR_CODES).length + " " + t.REFUSAL_CODES.length + " " + t.SUPPORTED_MODELS.length);';
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: PACKAGE, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^[1-9]\d* [1-9]\d* [1-9]\d*$/);
  });
});
