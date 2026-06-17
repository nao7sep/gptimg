import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeAlphaBBox, runTrim } from "../../src/local/trim.js";

async function writeRawPng(
  filePath: string,
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<void> {
  await sharp(Buffer.from(rgba), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toFile(filePath);
}

async function readRGBA(filePath: string): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

function makeRGBA(
  W: number,
  H: number,
  opaque: { x0: number; y0: number; x1: number; y1: number; r?: number; g?: number; b?: number } | null,
): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  if (!opaque) return rgba; // fully transparent
  const { x0, y0, x1, y1, r = 200, g = 100, b = 50 } = opaque;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("computeAlphaBBox", () => {
  it("finds the tightest rect of opaque pixels", () => {
    const rgba = makeRGBA(32, 32, { x0: 8, y0: 12, x1: 23, y1: 27 });
    expect(computeAlphaBBox(rgba, 32, 32)).toEqual({
      x: 8,
      y: 12,
      width: 16,
      height: 16,
    });
  });

  it("returns null when the image is fully transparent", () => {
    expect(computeAlphaBBox(makeRGBA(16, 16, null), 16, 16)).toBeNull();
  });

  it("handles a single opaque pixel", () => {
    const rgba = makeRGBA(16, 16, { x0: 5, y0: 7, x1: 5, y1: 7 });
    expect(computeAlphaBBox(rgba, 16, 16)).toEqual({
      x: 5,
      y: 7,
      width: 1,
      height: 1,
    });
  });

  it("treats partial alpha (>0) as opaque", () => {
    const W = 4;
    const H = 4;
    const rgba = new Uint8Array(W * H * 4);
    // single pixel at (1,1) with alpha=1 (just barely > 0)
    const i = (1 * W + 1) * 4;
    rgba[i + 3] = 1;
    expect(computeAlphaBBox(rgba, W, H)).toEqual({
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    });
  });
});

describe("runTrim", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-trim-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("crops to the alpha bbox + relative margin (non-square)", async () => {
    // 64x64 canvas, 16x32 opaque rect
    const W = 64;
    const H = 64;
    const rgba = makeRGBA(W, H, { x0: 10, y0: 8, x1: 25, y1: 39 });
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);

    const res = await runTrim({ in: inPath, out: outPath, margin: 0.1 });
    // bbox is 16x32, longer side = 32, margin = round(0.1 * 32) = 3 px each side
    expect(res.bbox).toEqual({ x: 10, y: 8, width: 16, height: 32 });
    expect(res.marginPx).toBe(3);
    expect(res.width).toBe(16 + 6);
    expect(res.height).toBe(32 + 6);
    expect(res.square).toBe(false);

    const out = await readRGBA(outPath);
    expect(out.width).toBe(22);
    expect(out.height).toBe(38);
    // The corner pixels of the output should be fully transparent (margin pad).
    expect(out.data[3]).toBe(0);
    expect(out.data[(out.width - 1) * 4 + 3]).toBe(0);
    // The bbox center should be opaque with the original color.
    const cx = Math.floor(out.width / 2);
    const cy = Math.floor(out.height / 2);
    const ci = (cy * out.width + cx) * 4;
    expect(out.data[ci]).toBe(200);
    expect(out.data[ci + 1]).toBe(100);
    expect(out.data[ci + 2]).toBe(50);
    expect(out.data[ci + 3]).toBe(255);
  });

  it("produces a square output when --square is set, even from a tall bbox", async () => {
    // 8x32 opaque rect → contentW = 8+6=14 (with margin 0.1*32=3), contentH = 32+6=38, final = 38x38
    const W = 64;
    const H = 64;
    const rgba = makeRGBA(W, H, { x0: 20, y0: 4, x1: 27, y1: 35 });
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);

    const res = await runTrim({
      in: inPath,
      out: outPath,
      margin: 0.1,
      square: true,
    });
    expect(res.bbox).toEqual({ x: 20, y: 4, width: 8, height: 32 });
    expect(res.marginPx).toBe(3);
    expect(res.width).toBe(38);
    expect(res.height).toBe(38);
    expect(res.square).toBe(true);

    const out = await readRGBA(outPath);
    expect(out.width).toBe(out.height);
    expect(out.width).toBe(38);
  });

  it("produces a square output when --square is set, even from a wide bbox", async () => {
    // 32x8 opaque rect → final 38x38
    const W = 64;
    const H = 64;
    const rgba = makeRGBA(W, H, { x0: 4, y0: 20, x1: 35, y1: 27 });
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);

    const res = await runTrim({
      in: inPath,
      out: outPath,
      margin: 0.1,
      square: true,
    });
    expect(res.width).toBe(38);
    expect(res.height).toBe(38);
  });

  it("with margin=0 the output is exactly the bbox crop", async () => {
    const W = 32;
    const H = 32;
    const rgba = makeRGBA(W, H, { x0: 5, y0: 7, x1: 24, y1: 18 });
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);

    const res = await runTrim({ in: inPath, out: outPath, margin: 0 });
    expect(res.marginPx).toBe(0);
    expect(res.width).toBe(20);
    expect(res.height).toBe(12);
    const out = await readRGBA(outPath);
    expect(out.width).toBe(20);
    expect(out.height).toBe(12);
    // Every pixel in the bbox crop should be the source color (no margin).
    expect(out.data[3]).toBe(255);
    expect(out.data[0]).toBe(200);
  });

  it("handles a fully-opaque image (bbox is the whole canvas)", async () => {
    const W = 16;
    const H = 16;
    const rgba = makeRGBA(W, H, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    const inPath = path.join(tmp, "opaque.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);

    const res = await runTrim({ in: inPath, out: outPath, margin: 0.1 });
    expect(res.bbox).toEqual({ x: 0, y: 0, width: 16, height: 16 });
    // margin = round(0.1 * 16) = 2 → output 20x20
    expect(res.marginPx).toBe(2);
    expect(res.width).toBe(20);
    expect(res.height).toBe(20);
    const out = await readRGBA(outPath);
    expect(out.width).toBe(20);
    expect(out.height).toBe(20);
    // Corner of the original (now at (2, 2) in output) is opaque source color.
    const i = (2 * out.width + 2) * 4;
    expect(out.data[i + 3]).toBe(255);
    expect(out.data[i]).toBe(200);
  });

  it("uses the default margin (0.08) when none is supplied", async () => {
    const W = 64;
    const H = 64;
    const rgba = makeRGBA(W, H, { x0: 0, y0: 0, x1: 49, y1: 49 });
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);

    const res = await runTrim({ in: inPath, out: outPath });
    expect(res.margin).toBe(0.08);
    expect(res.marginPx).toBe(4); // round(0.08 * 50) = 4
    expect(res.width).toBe(58);
    expect(res.height).toBe(58);
  });

  it("throws image.noContent on a fully transparent image", async () => {
    const W = 16;
    const H = 16;
    const inPath = path.join(tmp, "blank.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, makeRGBA(W, H, null));

    await expect(
      runTrim({ in: inPath, out: outPath, margin: 0.1 }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "image.noContent",
    });
  });

  // The margin [0..1] bound now lives in verbs/schemas.ts (validateTrimArgs)
  // and is covered by tests/verbs/schemas.test.ts.
});
