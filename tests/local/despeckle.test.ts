import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDespeckle } from "../../src/local/despeckle.js";

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
}> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

function blank(W: number, H: number): Uint8Array {
  return new Uint8Array(W * H * 4);
}
function setA(buf: Uint8Array, W: number, x: number, y: number, a: number): void {
  const i = (y * W + x) * 4;
  buf[i] = 200;
  buf[i + 1] = 100;
  buf[i + 2] = 50;
  buf[i + 3] = a;
}
function fillRect(
  buf: Uint8Array,
  W: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  a: number,
): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setA(buf, W, x, y, a);
}
function alphaAt(img: { data: Uint8Array; width: number }, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3]!;
}

describe("runDespeckle", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-despeckle-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("floors alpha below threshold and keeps alpha >= threshold", async () => {
    // 4x1 row: alphas [3, 5, 200, 0]
    const W = 4, H = 1;
    const buf = blank(W, H);
    setA(buf, W, 0, 0, 3);
    setA(buf, W, 1, 0, 5);
    setA(buf, W, 2, 0, 200);
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, minArea: 0 });
    expect(res.flooredPixels).toBe(1); // the alpha-3 pixel
    expect(res.removedPixels).toBe(0);

    const out = await readRGBA(outPath);
    expect(alphaAt(out, 0, 0)).toBe(0); // floored
    expect(alphaAt(out, 1, 0)).toBe(5); // kept (== threshold)
    expect(alphaAt(out, 2, 0)).toBe(200); // kept
  });

  it("removes a small isolated speckle but keeps every large component (multi-piece safe)", async () => {
    const W = 20, H = 10;
    const buf = blank(W, H);
    fillRect(buf, W, 1, 1, 5, 5, 255); // blob A, area 25
    fillRect(buf, W, 12, 1, 16, 5, 255); // blob B, area 25
    setA(buf, W, 18, 8, 255); // lone speckle, area 1
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({
      in: inPath,
      out: outPath,
      threshold: 5,
      minArea: 10,
      connectivity: 8,
      keep: "all",
    });
    expect(res.components).toBe(3);
    expect(res.removedComponents).toBe(1);
    expect(res.removedPixels).toBe(1);
    // bbox shrinks once the far speckle is gone.
    expect(res.bboxBefore).toEqual({ x: 1, y: 1, width: 18, height: 8 });
    expect(res.bboxAfter).toEqual({ x: 1, y: 1, width: 16, height: 5 });

    const out = await readRGBA(outPath);
    expect(alphaAt(out, 3, 3)).toBe(255); // blob A kept
    expect(alphaAt(out, 14, 3)).toBe(255); // blob B kept
    expect(alphaAt(out, 18, 8)).toBe(0); // speckle removed
  });

  it("keep=largest keeps only the biggest component", async () => {
    const W = 20, H = 10;
    const buf = blank(W, H);
    fillRect(buf, W, 1, 1, 5, 5, 255); // blob A, area 25 (largest)
    fillRect(buf, W, 12, 1, 14, 3, 255); // blob B, area 9
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, keep: "largest" });
    expect(res.components).toBe(2);
    expect(res.removedComponents).toBe(1);
    expect(res.removedPixels).toBe(9);

    const out = await readRGBA(outPath);
    expect(alphaAt(out, 3, 3)).toBe(255); // largest kept
    expect(alphaAt(out, 13, 2)).toBe(0); // smaller removed
  });

  it("connectivity changes whether a diagonal pair is one component", async () => {
    const W = 4, H = 4;
    const in4 = path.join(tmp, "in4.png");
    const in8 = path.join(tmp, "in8.png");
    const buf = blank(W, H);
    setA(buf, W, 1, 1, 255);
    setA(buf, W, 2, 2, 255); // touches (1,1) only diagonally
    await writeRawPng(in4, W, H, buf);
    await writeRawPng(in8, W, H, buf);

    const r4 = await runDespeckle({
      in: in4,
      out: path.join(tmp, "o4.png"),
      threshold: 5,
      minArea: 2,
      connectivity: 4,
    });
    expect(r4.components).toBe(2); // two separate 1-px components
    expect(r4.removedPixels).toBe(2); // both < minArea 2

    const r8 = await runDespeckle({
      in: in8,
      out: path.join(tmp, "o8.png"),
      threshold: 5,
      minArea: 2,
      connectivity: 8,
    });
    expect(r8.components).toBe(1); // one 2-px diagonal component
    expect(r8.removedPixels).toBe(0); // size 2 >= minArea 2
  });

  it("dryRun computes stats but writes nothing", async () => {
    const W = 4, H = 1;
    const buf = blank(W, H);
    setA(buf, W, 0, 0, 3);
    setA(buf, W, 1, 0, 200);
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({
      in: inPath,
      out: outPath,
      threshold: 5,
      minArea: 0,
      dryRun: true,
    });
    expect(res.output).toBeNull();
    expect(res.flooredPixels).toBe(1);
    expect(existsSync(outPath)).toBe(false);
  });

  it("is a graceful no-op on a fully-transparent image", async () => {
    const W = 8, H = 8;
    const inPath = path.join(tmp, "blank.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, blank(W, H));

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, minArea: 10 });
    expect(res.output).toBe(outPath);
    expect(res.components).toBe(0);
    expect(res.removedPixels).toBe(0);
    expect(res.flooredPixels).toBe(0);
    expect(res.bboxBefore).toBeNull();
    expect(res.bboxAfter).toBeNull();

    const out = await readRGBA(outPath);
    expect(out.width).toBe(W);
    let maxAlpha = 0;
    for (let p = 0; p < W * H; p++) maxAlpha = Math.max(maxAlpha, out.data[p * 4 + 3]!);
    expect(maxAlpha).toBe(0);
  });
});
