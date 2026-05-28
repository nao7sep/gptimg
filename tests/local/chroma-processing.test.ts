import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect } from "../../src/local/chroma/detect.js";

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
