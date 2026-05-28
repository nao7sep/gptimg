import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect } from "../../src/local/chroma/detect.js";
import { runChroma } from "../../src/local/chroma/index.js";
import { solveMatting } from "../../src/local/chroma/matting.js";

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

/**
 * Synthesize a "hair-on-green" test image. The frame is bright key green.
 * A solid yellow oval sits in the middle (the head/subject body). Several
 * thin yellow strands extend outward into the green, each strand fading
 * linearly to the key color over a few pixels — this is the semi-transparent
 * hair tip case that the old inverse-decontamination collapsed into black.
 */
function makeHairOnGreen(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    rgba[i] = 0;
    rgba[i + 1] = 255;
    rgba[i + 2] = 0;
    rgba[i + 3] = 255;
  }
  const cx = width / 2;
  const cy = height / 2;
  const rx = width * 0.22;
  const ry = height * 0.22;
  const subjectR = 230;
  const subjectG = 200;
  const subjectB = 60;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) {
        const i = (y * width + x) * 4;
        rgba[i] = subjectR;
        rgba[i + 1] = subjectG;
        rgba[i + 2] = subjectB;
      }
    }
  }
  const strandLen = 14;
  const strands = [
    { ox: -1, oy: 0 },
    { ox: 1, oy: 0 },
    { ox: -0.7, oy: -0.7 },
    { ox: 0.7, oy: -0.7 },
  ];
  for (const s of strands) {
    for (let t = 0; t < strandLen; t++) {
      const fx = Math.round(cx + s.ox * (rx + t));
      const fy = Math.round(cy + s.oy * (ry + t));
      if (fx < 0 || fy < 0 || fx >= width || fy >= height) continue;
      const i = (fy * width + fx) * 4;
      const w = 1 - t / strandLen;
      rgba[i] = Math.round(subjectR * w + 0 * (1 - w));
      rgba[i + 1] = Math.round(subjectG * w + 255 * (1 - w));
      rgba[i + 2] = Math.round(subjectB * w + 0 * (1 - w));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("solveMatting (spill-based)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-matting-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("makes pure-key pixels fully transparent regardless of position", async () => {
    const W = 32;
    const H = 32;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 255;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    // Yellow ring around the border with a pure-green pixel in the middle.
    for (let y = 4; y < W - 4; y++) {
      for (let x = 4; x < W - 4; x++) {
        const i = (y * W + x) * 4;
        if (x === W / 2 && y === H / 2) continue; // leave the center green
        rgba[i] = 220;
        rgba[i + 1] = 200;
        rgba[i + 2] = 60;
      }
    }
    const file = path.join(tmp, "interior-green.png");
    await writeRawPng(file, W, H, rgba);

    const det = await detect({ in: file });
    const matted = solveMatting(
      det.rgba,
      det.width,
      det.height,
      det.accepted,
      det.keyResolution.hex,
    );
    // Center pure-green pixel must be transparent by default.
    const centerP = (H / 2) * W + W / 2;
    expect(matted.alpha[centerP]).toBe(0);
  });

  it("preserveInterior keeps interior key-colored pixels opaque", async () => {
    const W = 32;
    const H = 32;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 255;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    // 4x4 pure green block in the middle of a yellow square (mimicking a
    // donut hole / rainbow-poop green segment).
    for (let y = 4; y < W - 4; y++) {
      for (let x = 4; x < W - 4; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 220;
        rgba[i + 1] = 200;
        rgba[i + 2] = 60;
      }
    }
    for (let y = 14; y < 18; y++) {
      for (let x = 14; x < 18; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 0;
        rgba[i + 1] = 255;
        rgba[i + 2] = 0;
      }
    }
    const file = path.join(tmp, "interior-block.png");
    await writeRawPng(file, W, H, rgba);

    const det = await detect({ in: file, preserveInterior: true });
    const matted = solveMatting(
      det.rgba,
      det.width,
      det.height,
      det.accepted,
      det.keyResolution.hex,
      { preserveInterior: true },
    );
    const center = (16 * W + 16) * 4;
    expect(matted.rgba[center + 3]).toBe(255);
  });

  it("never produces near-black pixels at the matte boundary on synthesized hair", async () => {
    const W = 64;
    const H = 64;
    const rgba = makeHairOnGreen(W, H);
    const file = path.join(tmp, "hair.png");
    await writeRawPng(file, W, H, rgba);

    const det = await detect({ in: file });
    const matted = solveMatting(
      det.rgba,
      det.width,
      det.height,
      det.accepted,
      det.keyResolution.hex,
    );

    let nearBlackOnPartial = 0;
    let partialPixels = 0;
    let solidOpaque = 0;
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      const a = matted.alpha[p]!;
      if (a === 255) solidOpaque++;
      if (a <= 30 || a === 255) continue;
      partialPixels++;
      const maxC = Math.max(matted.rgba[i]!, matted.rgba[i + 1]!, matted.rgba[i + 2]!);
      if (maxC < 40) nearBlackOnPartial++;
    }
    expect(partialPixels).toBeGreaterThan(0);
    expect(solidOpaque).toBeGreaterThan(0);
    expect(nearBlackOnPartial).toBe(0);
  });

  it("inpainted F preserves subject color rather than darkening at the boundary", async () => {
    // A yellow square on green. After matting, boundary pixels should carry
    // yellow-ish color (high R+G), not Vlahos-clipped near-black.
    const W = 48;
    const H = 48;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 255;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    for (let y = 12; y < 36; y++) {
      for (let x = 12; x < 36; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 230;
        rgba[i + 1] = 180;
        rgba[i + 2] = 50;
      }
    }
    const file = path.join(tmp, "yellow-square.png");
    await writeRawPng(file, W, H, rgba);

    const det = await detect({ in: file });
    const matted = solveMatting(
      det.rgba,
      det.width,
      det.height,
      det.accepted,
      det.keyResolution.hex,
    );
    // Pick an opaque pixel near the subject boundary.
    let checked = 0;
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      if (matted.alpha[p]! < 200) continue;
      // Boundary check: at least one neighbor is transparent
      const x = p % W;
      const y = Math.floor(p / W);
      let nearTransparent = false;
      for (let dy = -1; dy <= 1 && !nearTransparent; dy++) {
        for (let dx = -1; dx <= 1 && !nearTransparent; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (matted.alpha[ny * W + nx]! < 30) nearTransparent = true;
        }
      }
      if (!nearTransparent) continue;
      checked++;
      const r = matted.rgba[i]!;
      const g = matted.rgba[i + 1]!;
      const b = matted.rgba[i + 2]!;
      expect(r).toBeGreaterThan(100); // not near-black
      expect(g).toBeGreaterThan(60);
      // and inpainted from yellow, so red is the dominant channel
      expect(r).toBeGreaterThanOrEqual(b);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps donut hole opaque with --preserve-interior; removes it without", async () => {
    const W = 64;
    const H = 64;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 255;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    const cx = W / 2;
    const cy = H / 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 <= 22 * 22 && d2 >= 8 * 8) {
          const i = (y * W + x) * 4;
          rgba[i] = 220;
          rgba[i + 1] = 60;
          rgba[i + 2] = 60;
        }
      }
    }
    const file = path.join(tmp, "donut.png");
    await writeRawPng(file, W, H, rgba);

    const kept = await runChroma({
      in: file,
      outDir: tmp,
      outName: "donut-kept.png",
      maskName: false,
      preserveInterior: true,
      overwrite: true,
    });
    const removed = await runChroma({
      in: file,
      outDir: tmp,
      outName: "donut-removed.png",
      maskName: false,
      preserveInterior: false,
      overwrite: true,
    });

    const keptBytes = (await sharp(kept.imagePath).raw().toBuffer({ resolveWithObject: true })).data;
    const removedBytes = (await sharp(removed.imagePath).raw().toBuffer({ resolveWithObject: true })).data;
    const center = (Math.floor(cy) * W + Math.floor(cx)) * 4;
    expect(keptBytes[center + 3]).toBeGreaterThan(200);
    expect(removedBytes[center + 3]).toBeLessThan(20);
  });
});
