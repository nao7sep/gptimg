import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runResize } from "../../src/local/resize.js";
import type { ResampleKernel } from "../../src/types.js";

async function writeRawPng(
  filePath: string,
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<void> {
  await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
    .png()
    .toFile(filePath);
}

async function readRGBA(filePath: string): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
  hasAlpha: boolean;
}> {
  const meta = await sharp(filePath).metadata();
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    channels: meta.channels ?? 0,
    hasAlpha: meta.hasAlpha ?? false,
  };
}

function pixelAt(
  img: { data: Uint8Array; width: number },
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i]!, g: img.data[i + 1]!, b: img.data[i + 2]!, a: img.data[i + 3]! };
}

/** Transparent canvas with an opaque red center block. */
function diskish(W: number, H: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  const x0 = Math.floor(W * 0.3), x1 = Math.ceil(W * 0.7);
  const y0 = Math.floor(H * 0.3), y1 = Math.ceil(H * 0.7);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = 220; rgba[i + 1] = 40; rgba[i + 2] = 40; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("runResize", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-resize-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("downscales preserving alpha (no model)", async () => {
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, 100, 100, diskish(100, 100));

    const res = await runResize({ in: inPath, out: outPath, toSize: 50, kernel: "lanczos3" });
    expect(res.sourceWidth).toBe(100);
    expect(res.width).toBe(50);
    expect(res.height).toBe(50);
    expect(res.kernel).toBe("lanczos3");

    const out = await readRGBA(outPath);
    expect(out.width).toBe(50);
    expect(out.hasAlpha).toBe(true);
    expect(out.channels).toBe(4);
    // Corner transparent, center opaque red — alpha survived the shrink.
    expect(pixelAt(out, 1, 1).a).toBe(0);
    const c = pixelAt(out, 25, 25);
    expect(c.a).toBe(255);
    expect(c.r).toBeGreaterThan(180);
  });

  it("enlarges too (plain resample, any direction)", async () => {
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, 32, 32, diskish(32, 32));

    const res = await runResize({ in: inPath, out: outPath, toSize: 64 });
    expect(res.width).toBe(64);
    expect(res.height).toBe(64);
    const out = await readRGBA(outPath);
    expect(out.width).toBe(64);
    expect(pixelAt(out, 32, 32).a).toBe(255);
  });

  it("preserves aspect: toSize is the longer side", async () => {
    const inPath = path.join(tmp, "wide.png");
    await writeRawPng(inPath, 40, 20, diskish(40, 20));
    const res = await runResize({ in: inPath, out: path.join(tmp, "o.png"), toSize: 80 });
    expect(res.width).toBe(80);
    expect(res.height).toBe(40);
  });

  it("uses lanczos3 by default", async () => {
    const inPath = path.join(tmp, "in.png");
    await writeRawPng(inPath, 64, 64, diskish(64, 64));
    const res = await runResize({ in: inPath, out: path.join(tmp, "o.png"), toSize: 32 });
    expect(res.kernel).toBe("lanczos3");
  });

  it("accepts every kernel", async () => {
    const inPath = path.join(tmp, "in.png");
    await writeRawPng(inPath, 64, 64, diskish(64, 64));
    for (const k of ["nearest", "cubic", "mitchell", "lanczos2", "lanczos3"] as ResampleKernel[]) {
      const res = await runResize({ in: inPath, out: path.join(tmp, `o-${k}.png`), toSize: 48, kernel: k });
      expect(res.width).toBe(48);
      const out = await readRGBA(res.output);
      expect(out.width).toBe(48);
    }
  });

  // to-size range and kernel-enum rejections now live in verbs/schemas.ts
  // (validateResizeArgs) and are covered by tests/verbs/schemas.test.ts.
  it("reports a clean error when the input cannot be read", async () => {
    await expect(
      runResize({ in: path.join(tmp, "missing.png"), out: path.join(tmp, "o.png"), toSize: 32 }),
    ).rejects.toMatchObject({ errorType: "localOp", code: "image.decodeFailed" });
  });
});
