import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUpscale, type RgbUpscaler } from "../../src/local/upscale.js";
import {
  planTiles,
  tileAndStitch,
  SWIN2SR_SCALE,
  type PaddedModelRun,
} from "../../src/local/models/swin2sr.js";
import type { Logger } from "../../src/log/index.js";

/** Minimal Logger that records the messages forwarded to it. */
function recordingLogger(events: { stage: string; msg: string }[]): Logger {
  return {
    handle: { path: "mem.jsonl", verb: "upscale" },
    info: async (stage, msg) => {
      events.push({ stage, msg });
    },
    warn: async () => {},
    error: async () => {},
    close: async () => {},
  };
}

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

// Deterministic ×4 of a /8-aligned interleaved-RGB buffer (stands in for ONNX).
const nearestPaddedX4: PaddedModelRun = async (rgb, pw, ph) => {
  const S = SWIN2SR_SCALE;
  const ow = pw * S;
  const oh = ph * S;
  const out = new Uint8Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    const sy = (y / S) | 0;
    for (let x = 0; x < ow; x++) {
      const sx = (x / S) | 0;
      const s = (sy * pw + sx) * 3;
      const d = (y * ow + x) * 3;
      out[d] = rgb[s]!;
      out[d + 1] = rgb[s + 1]!;
      out[d + 2] = rgb[s + 2]!;
    }
  }
  return out;
};

function rgbPattern(W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      out[i] = (x * 7) & 255;
      out[i + 1] = (y * 5) & 255;
      out[i + 2] = ((x ^ y) * 3) & 255;
    }
  }
  return out;
}

function nearestWholeX4(rgb: Uint8Array, W: number, H: number): Uint8Array {
  const S = SWIN2SR_SCALE;
  const ow = W * S;
  const oh = H * S;
  const out = new Uint8Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    const sy = (y / S) | 0;
    for (let x = 0; x < ow; x++) {
      const sx = (x / S) | 0;
      const s = (sy * W + sx) * 3;
      const d = (y * ow + x) * 3;
      out[d] = rgb[s]!;
      out[d + 1] = rgb[s + 1]!;
      out[d + 2] = rgb[s + 2]!;
    }
  }
  return out;
}

describe("tileAndStitch", () => {
  // For a deterministic per-tile ×4, the seam-cropped tiled stitch must be
  // byte-identical to a single-pass ×4 of the whole image — this exercises
  // extractRegion, the /8 reflect-pad + crop, and the leftCtx/topCtx placement
  // (the path the runUpscale tests bypass via an injected whole-image upscaler).
  it.each([
    [13, 13, 256], // single tile, non-/8 (triggers pad+crop)
    [200, 200, 256], // 2×2 tiles, /8 sizes
    [37, 29, 96], // multi-tile + non-/8 fed widths
    [64, 64, 72], // min tile → many small tiles
  ])("reconstructs %ix%i (tile=%i) identically to a single pass", async (W, H, tile) => {
    const src = rgbPattern(W, H);
    const tiled = await tileAndStitch(src, W, H, tile, nearestPaddedX4);
    const whole = nearestWholeX4(src, W, H);
    expect(tiled.width).toBe(W * SWIN2SR_SCALE);
    expect(tiled.height).toBe(H * SWIN2SR_SCALE);
    expect(tiled.tiles).toBe(planTiles(W, H, tile, 32).length);
    let firstDiff = -1;
    for (let i = 0; i < whole.length; i++) {
      if (tiled.rgb[i] !== whole[i]) {
        firstDiff = i;
        break;
      }
    }
    expect(firstDiff).toBe(-1);
  });

  it("emits one infer progress event per tile through the logger", async () => {
    const W = 200,
      H = 200,
      tile = 256; // region 192 → 2×2 tiles
    const src = rgbPattern(W, H);
    const events: { stage: string; msg: string }[] = [];
    await tileAndStitch(src, W, H, tile, nearestPaddedX4, undefined, recordingLogger(events));
    const n = planTiles(W, H, tile, 32).length;
    expect(events).toHaveLength(n);
    expect(events.every((e) => e.stage === "infer")).toBe(true);
    expect(events[0]!.msg).toBe(`upscaled tile 1/${n}`);
    expect(events[n - 1]!.msg).toBe(`upscaled tile ${n}/${n}`);
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

  // to-size / kernel / tile argument rejections now live in verbs/schemas.ts
  // (validateUpscaleArgs) and are covered by tests/verbs/schemas.test.ts.

  it("reports image.decodeFailed for a missing input even with valid args", async () => {
    // Valid args pass validation; the failure must come from loadRawRGBA,
    // before the (injected) upscaler is ever reached.
    await expect(
      runUpscale(
        { in: path.join(tmp, "nope.png"), out: path.join(tmp, "o.png"), toSize: 128 },
        tmp,
        { upscaler: nearestX4 },
      ),
    ).rejects.toMatchObject({ errorType: "localOp", code: "image.decodeFailed" });
  });
});
