import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect } from "../../src/local/chroma/detect.js";
import { runChroma } from "../../src/local/chroma/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

describe("chroma: green-disk", () => {
  it("detects the green chroma backdrop and removes the expected fraction", async () => {
    const res = await detect({ in: fixture("green-disk.png") });
    // Disc has radius 30 in 128x128 → background fraction ≈ 1 - π·30²/128² ≈ 0.827.
    expect(res.stats.removedFraction).toBeGreaterThan(0.78);
    expect(res.stats.removedFraction).toBeLessThan(0.88);
    expect(res.stats.regionsRemoved.length).toBe(1);
    expect(res.stats.regionsRemoved[0]?.touchesBorder).toBe(true);
    expect(res.stats.noKeyDetected).toBe(false);
    expect(res.stats.subjectKeyCollisionRisk).toBe(false);
    expect(res.stats.key).toMatch(/^#[0-9a-f]{6}$/);
    expect(res.stats.keySource).toBe("auto");
  });

});

describe("chroma: noisy-bg", () => {
  it("reports noKeyDetected=true when border variance is high", async () => {
    const res = await detect({ in: fixture("noisy-bg.png") });
    expect(res.stats.noKeyDetected).toBe(true);
  });
});

describe("chroma: donut", () => {
  it("preserveInterior keeps the hole's component out of the accepted set", async () => {
    const res = await detect({
      in: fixture("donut.png"),
      preserveInterior: true,
    });
    expect(res.stats.preserveInterior).toBe(true);
    expect(res.stats.regionsRemoved.length).toBe(1);
    expect(res.stats.regionsRemoved[0]?.touchesBorder).toBe(true);
  });

  it("default (no preserveInterior) accepts the interior hole as background too", async () => {
    const kept = await detect({
      in: fixture("donut.png"),
      preserveInterior: true,
    });
    const removed = await detect({ in: fixture("donut.png") });
    expect(removed.stats.regionsRemoved.length).toBeGreaterThan(
      kept.stats.regionsRemoved.length,
    );
    expect(removed.stats.removedFraction).toBeGreaterThan(
      kept.stats.removedFraction,
    );
    expect(
      removed.stats.regionsRemoved.some((r) => r.touchesBorder === false),
    ).toBe(true);
  });
});

describe("chroma: subject-collision", () => {
  it("flags subjectKeyCollisionRisk when a key-colored region is rejected", async () => {
    const res = await detect({
      in: fixture("subject-collision.png"),
      preserveInterior: true,
    });
    expect(res.stats.subjectKeyCollisionRisk).toBe(true);
  });
});

describe("runChroma: writes outputs", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-chroma-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes -chroma.png and -mask.png next to the input", async () => {
    const input = path.join(tmp, "in.png");
    await copyFile(fixture("green-disk.png"), input);
    const out = await runChroma({ in: input, overwrite: true });
    expect(existsSync(out.imagePath)).toBe(true);
    expect(out.maskPath).not.toBeNull();
    expect(existsSync(out.maskPath!)).toBe(true);
    expect(path.basename(out.imagePath)).toBe("in-chroma.png");
    expect(path.basename(out.maskPath!)).toBe("in-mask.png");
  });

  it("skips the mask file when maskName=false", async () => {
    const input = path.join(tmp, "in.png");
    await copyFile(fixture("green-disk.png"), input);
    const out = await runChroma({
      in: input,
      maskName: false,
      overwrite: true,
    });
    expect(existsSync(out.imagePath)).toBe(true);
    expect(out.maskPath).toBeNull();
  });

  it("errors on collision unless overwrite is set", async () => {
    const input = path.join(tmp, "in.png");
    await copyFile(fixture("green-disk.png"), input);
    await runChroma({ in: input, overwrite: true });
    await expect(runChroma({ in: input })).rejects.toMatchObject({
      code: "output.exists",
    });
  });

  it("checks mask collisions before writing a partial chroma image", async () => {
    const input = path.join(tmp, "in.png");
    const imagePath = path.join(tmp, "out.png");
    const maskPath = path.join(tmp, "mask.png");
    await copyFile(fixture("green-disk.png"), input);
    await copyFile(fixture("green-disk.png"), maskPath);

    await expect(
      runChroma({
        in: input,
        outName: imagePath,
        maskName: maskPath,
      }),
    ).rejects.toMatchObject({
      code: "output.exists",
    });
    expect(existsSync(imagePath)).toBe(false);
  });
});
