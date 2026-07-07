import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCombine } from "../../src/local/combine.js";

async function writeMaskPng(
  filePath: string,
  width: number,
  height: number,
  values: number[],
): Promise<void> {
  await sharp(Buffer.from(Uint8Array.from(values)), {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toFile(filePath);
}

async function readMask(filePath: string): Promise<Uint8Array> {
  const out = await sharp(filePath).grayscale().removeAlpha().raw().toBuffer();
  return new Uint8Array(out);
}

describe("runCombine", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-combine-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("union takes the pixelwise max", async () => {
    const a = path.join(tmp, "a.png");
    const b = path.join(tmp, "b.png");
    const out = path.join(tmp, "out.png");
    await writeMaskPng(a, 2, 1, [10, 200]);
    await writeMaskPng(b, 2, 1, [50, 100]);
    await runCombine({ op: "union", inputs: [a, b], out });
    const got = await readMask(out);
    expect(Array.from(got)).toEqual([50, 200]);
  });

  it("intersect takes the pixelwise min", async () => {
    const a = path.join(tmp, "a.png");
    const b = path.join(tmp, "b.png");
    const out = path.join(tmp, "out.png");
    await writeMaskPng(a, 2, 1, [10, 200]);
    await writeMaskPng(b, 2, 1, [50, 100]);
    await runCombine({ op: "intersect", inputs: [a, b], out });
    const got = await readMask(out);
    expect(Array.from(got)).toEqual([10, 100]);
  });

  it("subtract clamps below at zero", async () => {
    const a = path.join(tmp, "a.png");
    const b = path.join(tmp, "b.png");
    const out = path.join(tmp, "out.png");
    await writeMaskPng(a, 2, 1, [50, 200]);
    await writeMaskPng(b, 2, 1, [100, 50]);
    await runCombine({ op: "subtract", inputs: [a, b], out });
    const got = await readMask(out);
    expect(Array.from(got)).toEqual([0, 150]);
  });

  it("invert returns 255 - a", async () => {
    const a = path.join(tmp, "a.png");
    const out = path.join(tmp, "out.png");
    await writeMaskPng(a, 3, 1, [0, 128, 255]);
    await runCombine({ op: "invert", inputs: [a], out });
    const got = await readMask(out);
    expect(Array.from(got)).toEqual([255, 127, 0]);
  });

  it("feather smooths a sharp transition between 0 and 255", async () => {
    const a = path.join(tmp, "a.png");
    const out = path.join(tmp, "out.png");
    // 7x1 mask: hard step at x=3
    await writeMaskPng(a, 7, 1, [0, 0, 0, 255, 255, 255, 255]);
    await runCombine({ op: "feather", inputs: [a], out, radius: 1 });
    const got = await readMask(out);
    // The transition pixel and its neighbors should land between 0 and 255.
    const transition = got[3]!;
    expect(transition).toBeGreaterThan(0);
    expect(transition).toBeLessThan(255);
  });

  // Op/arity rejections now live in verbs/schemas.ts (validateCombineArgs) and
  // are covered by tests/verbs/schemas.test.ts.
  it("rejects mismatched input sizes", async () => {
    const a = path.join(tmp, "a.png");
    const b = path.join(tmp, "b.png");
    const out = path.join(tmp, "out.png");
    await writeMaskPng(a, 2, 1, [0, 255]);
    await writeMaskPng(b, 3, 1, [0, 128, 255]);
    await expect(
      runCombine({ op: "intersect", inputs: [a, b], out }),
    ).rejects.toMatchObject({ errorType: "localOp" });
  });
});
