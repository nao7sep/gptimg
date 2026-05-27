import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect } from "../../src/local/chroma/detect.js";
import {
  verifyChromaAlpha,
  writeCheckerboardPreview,
} from "../../src/local/chroma/verifyAlpha.js";

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

describe("chroma local processing details", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-chroma-processing-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("alpha verification detects interior transparency and key spill", async () => {
    const width = 12;
    const height = 12;
    const rgba = new Uint8Array(width * height * 4);
    for (let p = 0, i = 0; p < width * height; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = 0;
    }
    for (let y = 2; y < 10; y++) {
      for (let x = 2; x < 10; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = 200;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 255;
      }
    }
    for (let y = 5; y < 7; y++) {
      for (let x = 5; x < 7; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 0;
      }
    }
    for (let x = 2; x < 10; x++) {
      const top = (2 * width + x) * 4;
      rgba[top] = 20;
      rgba[top + 1] = 220;
      rgba[top + 2] = 20;
      rgba[top + 3] = 128;
      const bottom = (9 * width + x) * 4;
      rgba[bottom] = 20;
      rgba[bottom + 1] = 220;
      rgba[bottom + 2] = 20;
      rgba[bottom + 3] = 128;
    }
    for (let y = 2; y < 10; y++) {
      const left = (y * width + 2) * 4;
      rgba[left] = 20;
      rgba[left + 1] = 220;
      rgba[left + 2] = 20;
      rgba[left + 3] = 128;
      const right = (y * width + 9) * 4;
      rgba[right] = 20;
      rgba[right + 1] = 220;
      rgba[right + 2] = 20;
      rgba[right + 3] = 128;
    }

    const file = path.join(tmp, "alpha-check.png");
    await writeRawPng(file, width, height, rgba);

    const result = await verifyChromaAlpha(file, {
      key: "#00ff00",
      mode: "all",
      expectInteriorTransparency: true,
    });

    expect(result.metrics.interiorTransparentArea).toBeGreaterThan(0);
    expect(result.metrics.partialAlphaPixels).toBeGreaterThan(0);
    expect(result.metrics.boundaryKeyDominantPixels).toBeGreaterThan(0);
  });

  it("writes checkerboard previews with opaque alpha for vision", async () => {
    const file = path.join(tmp, "transparent.png");
    const preview = path.join(tmp, "preview.png");
    await writeRawPng(
      file,
      1,
      1,
      new Uint8Array([255, 0, 0, 128]),
    );

    await writeCheckerboardPreview(file, preview);

    const { data } = await sharp(preview).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    expect(data[3]).toBe(255);
    expect(data[0]).toBeGreaterThan(220);
    expect(data[1]).toBeGreaterThan(80);
  });

  it("fillHoles removes tiny holes in otherwise accepted background regions", async () => {
    const width = 32;
    const height = 32;
    const rgba = new Uint8Array(width * height * 4);
    for (let p = 0, i = 0; p < width * height; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 255;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = 255;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
      }
    }
    const hole = (4 * width + 4) * 4;
    rgba[hole] = 0;
    rgba[hole + 1] = 0;
    rgba[hole + 2] = 255;

    const file = path.join(tmp, "hole.png");
    await writeRawPng(file, width, height, rgba);

    const filled = await detect({ in: file, fillHoles: true });
    const unfilled = await detect({ in: file, fillHoles: false });

    expect(filled.stats.removedPixels).toBeGreaterThan(unfilled.stats.removedPixels);
  });
});
