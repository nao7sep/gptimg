import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hash } from "../../src/image/hash.js";
import { detect } from "../../src/local/chroma/detect.js";
import { runChroma } from "../../src/local/chroma/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

describe("chroma option paths", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-chroma-options-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("uses explicit key values", async () => {
    const result = await detect({
      in: fixture("green-disk.png"),
      key: "#00ff00",
    });

    expect(result.stats.key).toBe("#00ff00");
    expect(result.stats.keySource).toBe("explicit");
    expect(result.stats.noKeyDetected).toBe(false);
  });

  it("loads chroma key hints from sibling sidecars", async () => {
    const input = path.join(tmp, "generated-01.png");
    await copyFile(fixture("green-disk.png"), input);
    await writeFile(
      path.join(tmp, "generated.json"),
      JSON.stringify({
        request: { chroma: { color: "#00ff00" } },
        response: {},
        files: [],
      }) + "\n",
    );

    const result = await detect({ in: input, key: "from-sidecar" });

    expect(result.stats.key).toBe("#00ff00");
    expect(result.stats.keySource).toBe("sidecar");
  });

  it("reports missing sidecar chroma key hints as a local operation error", async () => {
    const input = path.join(tmp, "generated-01.png");
    await copyFile(fixture("green-disk.png"), input);

    await expect(detect({ in: input, key: "from-sidecar" })).rejects.toMatchObject({
      errorType: "localOp",
      code: "image.decodeFailed",
    });
  });

  it("writes custom output names without modifying the original input", async () => {
    const input = path.join(tmp, "in.png");
    const outDir = path.join(tmp, "custom-out");
    await copyFile(fixture("green-disk.png"), input);
    const before = hash(await readFile(input));

    const result = await runChroma({
      in: input,
      outDir,
      outName: "subject.png",
      maskName: "subject-mask.png",
    });

    expect(result.imagePath).toBe(path.join(outDir, "subject.png"));
    expect(result.maskPath).toBe(path.join(outDir, "subject-mask.png"));
    expect(existsSync(result.imagePath)).toBe(true);
    expect(existsSync(result.maskPath!)).toBe(true);
    expect(hash(await readFile(input))).toBe(before);
  });

  it("runChroma honors an already-aborted signal before writing outputs", async () => {
    const input = path.join(tmp, "abort-input.png");
    await copyFile(fixture("green-disk.png"), input);
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));

    await expect(
      runChroma(
        {
          in: input,
          outDir: tmp,
          outName: "abort-output.png",
          maskName: false,
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "cancelled",
    });
    expect(existsSync(path.join(tmp, "abort-output.png"))).toBe(false);
  });

  it("strict confidence can reject otherwise accepted regions", async () => {
    const normal = await detect({ in: fixture("green-disk.png") });
    const strict = await detect({
      in: fixture("green-disk.png"),
      strictConfidence: 1.1,
    });

    expect(normal.stats.regionsRemoved.length).toBeGreaterThan(0);
    expect(strict.stats.regionsRemoved).toHaveLength(0);
    expect(strict.stats.removedFraction).toBe(0);
  });

  it("inner threshold changes how much background is accepted", async () => {
    const strict = await detect({
      in: fixture("green-disk.png"),
      innerThreshold: 0,
    });
    const normal = await detect({ in: fixture("green-disk.png") });

    expect(strict.stats.removedFraction).toBeLessThan(normal.stats.removedFraction);
  });

  it("border sample changes the auto-key sample set", async () => {
    const shallow = await detect({
      in: fixture("green-disk.png"),
      borderSample: 1,
    });
    const deep = await detect({
      in: fixture("green-disk.png"),
      borderSample: 6,
    });

    expect(shallow.keyResolution.sampleIndices.length).toBeLessThan(
      deep.keyResolution.sampleIndices.length,
    );
  });

});
