import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUpscale, type RgbUpscaler } from "../../src/local/upscale.js";
import { planTiles } from "../../src/local/models/swin2sr.js";
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
}> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

function pixelAt(
  img: { data: Uint8Array; width: number },
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i]!, g: img.data[i + 1]!, b: img.data[i + 2]!, a: img.data[i + 3]! };
}

/** Deterministic ×4 nearest-neighbor upscaler — stands in for the ONNX model. */
const nearestX4: RgbUpscaler = async (rgb, width, height) => {
  const S = 4;
  const ow = width * S;
  const oh = height * S;
  const out = new Uint8Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    const sy = (y / S) | 0;
    for (let x = 0; x < ow; x++) {
      const sx = (x / S) | 0;
      const s = (sy * width + sx) * 3;
      const d = (y * ow + x) * 3;
      out[d] = rgb[s]!;
      out[d + 1] = rgb[s + 1]!;
      out[d + 2] = rgb[s + 2]!;
    }
  }
  return { rgb: out, width: ow, height: oh, tiles: 1 };
};

describe("planTiles", () => {
  it("covers a small image in a single tile with no context", () => {
    const specs = planTiles(100, 100, 256, 32);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s).toMatchObject({ ix: 0, iy: 0, tw: 100, th: 100, fw: 100, fh: 100, leftCtx: 0, topCtx: 0 });
  });

  it("tiles a larger image and the output regions tile the canvas exactly", () => {
    const W = 200;
    const H = 200;
    const specs = planTiles(W, H, 256, 32); // region = 192 → 2×2
    expect(specs).toHaveLength(4);

    // Output regions: no gaps, no overlap, full coverage.
    const covered = new Uint8Array(W * H);
    for (const s of specs) {
      // Fed region is in-bounds and includes context where room allows.
      expect(s.fx0).toBeGreaterThanOrEqual(0);
      expect(s.fy0).toBeGreaterThanOrEqual(0);
      expect(s.fx0 + s.fw).toBeLessThanOrEqual(W);
      expect(s.fy0 + s.fh).toBeLessThanOrEqual(H);
      expect(s.leftCtx).toBe(s.ix - s.fx0);
      expect(s.topCtx).toBe(s.iy - s.fy0);
      for (let y = s.iy; y < s.iy + s.th; y++) {
        for (let x = s.ix; x < s.ix + s.tw; x++) {
          covered[y * W + x]!++;
        }
      }
    }
    expect(covered.every((c) => c === 1)).toBe(true);

    // The top-left tile has no context (clamped at the border)…
    expect(specs[0]!.leftCtx).toBe(0);
    expect(specs[0]!.topCtx).toBe(0);
    // …an interior-touching tile carries the full overlap on its leading edge.
    const bottomRight = specs[3]!;
    expect(bottomRight.leftCtx).toBe(32);
    expect(bottomRight.topCtx).toBe(32);
  });
});

describe("runUpscale", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-upscale-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("runs ×4 then resamples to to-size, preserving alpha (injected model)", async () => {
    // 16×16: transparent everywhere except an opaque red center block.
    const W = 16;
    const H = 16;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 6; y <= 9; y++) {
      for (let x = 6; x <= 9; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 220;
        rgba[i + 1] = 30;
        rgba[i + 2] = 30;
        rgba[i + 3] = 255;
      }
    }
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);

    const res = await runUpscale(
      { in: inPath, out: outPath, toSize: 32, kernel: "nearest" },
      tmp,
      { upscaler: nearestX4 },
    );
    expect(res.sourceWidth).toBe(16);
    expect(res.modelWidth).toBe(64); // ×4
    expect(res.modelHeight).toBe(64);
    expect(res.width).toBe(32);
    expect(res.height).toBe(32);
    expect(res.kernel).toBe("nearest");
    expect(res.tile).toBe(256); // default
    expect(res.tiles).toBe(1);

    const out = await readRGBA(outPath);
    expect(out.width).toBe(32);
    expect(out.height).toBe(32);
    // Corner: transparent (alpha preserved through the separate alpha resample).
    expect(pixelAt(out, 1, 1).a).toBe(0);
    // Center: opaque red.
    const c = pixelAt(out, 16, 16);
    expect(c.a).toBe(255);
    expect(c.r).toBeGreaterThan(200);
    expect(c.g).toBeLessThan(60);
  });

  it("preserves aspect ratio: toSize is the longer side", async () => {
    const W = 10;
    const H = 20;
    const rgba = new Uint8Array(W * H * 4).fill(255);
    const inPath = path.join(tmp, "tall.png");
    await writeRawPng(inPath, W, H, rgba);

    const res = await runUpscale(
      { in: inPath, out: path.join(tmp, "out.png"), toSize: 40, kernel: "lanczos3" },
      tmp,
      { upscaler: nearestX4 },
    );
    expect(res.height).toBe(40); // longer side
    expect(res.width).toBe(20); // 40 * 10/20
  });

  it("rejects an out-of-range to-size", async () => {
    const inPath = path.join(tmp, "x.png");
    await expect(
      runUpscale({ in: inPath, out: path.join(tmp, "o.png"), toSize: 0 }, tmp, { upscaler: nearestX4 }),
    ).rejects.toMatchObject({ errorType: "localOp", code: "args.invalid" });
    await expect(
      runUpscale({ in: inPath, out: path.join(tmp, "o.png"), toSize: 100.5 }, tmp, { upscaler: nearestX4 }),
    ).rejects.toMatchObject({ code: "args.invalid" });
    await expect(
      runUpscale({ in: inPath, out: path.join(tmp, "o.png"), toSize: 100000 }, tmp, { upscaler: nearestX4 }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("rejects an unknown kernel", async () => {
    await expect(
      runUpscale(
        { in: path.join(tmp, "x.png"), out: path.join(tmp, "o.png"), kernel: "bogus" as ResampleKernel },
        tmp,
        { upscaler: nearestX4 },
      ),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("rejects a tile below the minimum", async () => {
    await expect(
      runUpscale({ in: path.join(tmp, "x.png"), out: path.join(tmp, "o.png"), tile: 50 }, tmp, {
        upscaler: nearestX4,
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
    await expect(
      runUpscale({ in: path.join(tmp, "x.png"), out: path.join(tmp, "o.png"), tile: 100.5 }, tmp, {
        upscaler: nearestX4,
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });
});
