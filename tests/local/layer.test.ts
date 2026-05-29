import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLayer } from "../../src/local/layer.js";

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

function makeSolid(
  W: number,
  H: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  }
  return rgba;
}

function pixelAt(
  img: { data: Uint8Array; width: number },
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const i = (y * img.width + x) * 4;
  return {
    r: img.data[i]!,
    g: img.data[i + 1]!,
    b: img.data[i + 2]!,
    a: img.data[i + 3]!,
  };
}

describe("runLayer", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-layer-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("composites top centered onto base at native size; output is base-sized", async () => {
    // 64x64 blue base
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 64, 64, makeSolid(64, 64, 0, 0, 200));
    // 16x16 red top
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 16, 16, makeSolid(16, 16, 220, 0, 0));
    const outPath = path.join(tmp, "out.png");

    const res = await runLayer({ base: basePath, top: topPath, out: outPath });
    expect(res.width).toBe(64);
    expect(res.height).toBe(64);
    expect(res.topWidth).toBe(16);
    expect(res.topHeight).toBe(16);
    expect(res.gravity).toBe("center");
    expect(res.topOffset).toBeNull();

    const img = await readRGBA(outPath);
    expect(img.width).toBe(64);
    expect(img.height).toBe(64);
    // Corner: untouched blue base.
    const c = pixelAt(img, 2, 2);
    expect(c.r).toBeLessThan(30);
    expect(c.b).toBeGreaterThan(150);
    // Center: red top.
    const ctr = pixelAt(img, 32, 32);
    expect(ctr.r).toBeGreaterThan(200);
    expect(ctr.b).toBeLessThan(30);
  });

  it("--scale resizes top relative to the base's shorter side", async () => {
    // 100x80 base, 50x50 top, scale = 0.5 → target longer = 0.5 * 80 = 40
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 100, 80, makeSolid(100, 80, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 50, 50, makeSolid(50, 50, 200, 200, 200));
    const outPath = path.join(tmp, "out.png");

    const res = await runLayer({
      base: basePath,
      top: topPath,
      out: outPath,
      scale: 0.5,
    });
    expect(res.topWidth).toBe(40);
    expect(res.topHeight).toBe(40);
    expect(res.width).toBe(100);
    expect(res.height).toBe(80);
  });

  it("preserves aspect when scaling a non-square top", async () => {
    // 100x100 base, 30x60 top, scale = 0.6 → target longer = 60
    // longer side is the height (60), so topHeight = 60, topWidth = 60 * (30/60) = 30
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 100, 100, makeSolid(100, 100, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 30, 60, makeSolid(30, 60, 255, 255, 255));
    const outPath = path.join(tmp, "out.png");

    const res = await runLayer({
      base: basePath,
      top: topPath,
      out: outPath,
      scale: 0.6,
    });
    expect(res.topHeight).toBe(60);
    expect(res.topWidth).toBe(30);
  });

  it("--top-offset places top at explicit pixel coords (and reports it)", async () => {
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 64, 64, makeSolid(64, 64, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 8, 8, makeSolid(8, 8, 255, 0, 0));
    const outPath = path.join(tmp, "out.png");

    const res = await runLayer({
      base: basePath,
      top: topPath,
      out: outPath,
      topOffset: { x: 4, y: 4 },
    });
    expect(res.gravity).toBeNull();
    expect(res.topOffset).toEqual({ x: 4, y: 4 });

    const img = await readRGBA(outPath);
    // The 8x8 red top sits at (4..11, 4..11). Sample (5, 5) → red.
    const p = pixelAt(img, 5, 5);
    expect(p.r).toBeGreaterThan(200);
    // Outside the top: still base black.
    const q = pixelAt(img, 20, 20);
    expect(q.r).toBeLessThan(30);
  });

  it("preserves base transparency outside the top (proper alpha composite, not flatten)", async () => {
    // 32x32 fully-transparent base
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 32, 32, new Uint8Array(32 * 32 * 4));
    // 8x8 opaque red top, centered → covers x=12..19, y=12..19
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 8, 8, makeSolid(8, 8, 255, 0, 0));
    const outPath = path.join(tmp, "out.png");

    await runLayer({ base: basePath, top: topPath, out: outPath });

    const img = await readRGBA(outPath);
    // Outside the top: alpha = 0.
    expect(pixelAt(img, 2, 2).a).toBe(0);
    // Inside the top: alpha = 255, red.
    const c = pixelAt(img, 16, 16);
    expect(c.a).toBe(255);
    expect(c.r).toBeGreaterThan(200);
  });

  it("rejects scale <= 0", async () => {
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 16, 16, makeSolid(16, 16, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 8, 8, makeSolid(8, 8, 255, 0, 0));
    const outPath = path.join(tmp, "out.png");

    await expect(
      runLayer({ base: basePath, top: topPath, out: outPath, scale: 0 }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "args.invalid",
    });
    await expect(
      runLayer({ base: basePath, top: topPath, out: outPath, scale: -0.5 }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("rejects --scale that resolves to <1 px with args.invalid", async () => {
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 10, 10, makeSolid(10, 10, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 4, 4, makeSolid(4, 4, 255, 0, 0));
    await expect(
      runLayer({
        base: basePath,
        top: topPath,
        out: path.join(tmp, "out.png"),
        scale: 0.001, // 0.001 * 10 = 0.01 → rounds to 0 → <1
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("rejects a top larger than the base in either axis (no --scale)", async () => {
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 16, 16, makeSolid(16, 16, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    // top wider than base
    await writeRawPng(topPath, 32, 8, makeSolid(32, 8, 255, 0, 0));
    await expect(
      runLayer({
        base: basePath,
        top: topPath,
        out: path.join(tmp, "out.png"),
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("rejects a negative --top-offset", async () => {
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 32, 32, makeSolid(32, 32, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 8, 8, makeSolid(8, 8, 255, 0, 0));
    await expect(
      runLayer({
        base: basePath,
        top: topPath,
        out: path.join(tmp, "out.png"),
        topOffset: { x: -1, y: 0 },
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("rejects a --top-offset that puts top past the base edge", async () => {
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 32, 32, makeSolid(32, 32, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 8, 8, makeSolid(8, 8, 255, 0, 0));
    await expect(
      runLayer({
        base: basePath,
        top: topPath,
        out: path.join(tmp, "out.png"),
        topOffset: { x: 30, y: 0 }, // 30 + 8 = 38 > 32
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("--gravity northeast anchors the top to the top-right of the base", async () => {
    const basePath = path.join(tmp, "base.png");
    await writeRawPng(basePath, 32, 32, makeSolid(32, 32, 0, 0, 0));
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 8, 8, makeSolid(8, 8, 220, 0, 0));
    const outPath = path.join(tmp, "out.png");

    const res = await runLayer({
      base: basePath,
      top: topPath,
      out: outPath,
      gravity: "northeast",
    });
    expect(res.gravity).toBe("northeast");

    const img = await readRGBA(outPath);
    // Top-right quadrant should sample as red.
    const ne = pixelAt(img, 28, 4);
    expect(ne.r).toBeGreaterThan(200);
    // Bottom-left quadrant should still be base black.
    const sw = pixelAt(img, 4, 28);
    expect(sw.r).toBeLessThan(30);
  });

  it("reports a clean error when the base file cannot be read", async () => {
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(topPath, 8, 8, makeSolid(8, 8, 255, 0, 0));
    await expect(
      runLayer({
        base: path.join(tmp, "missing.png"),
        top: topPath,
        out: path.join(tmp, "out.png"),
      }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "image.decodeFailed",
    });
  });
});
