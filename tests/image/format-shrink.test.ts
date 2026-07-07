import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { detectFormat } from "../../src/image/detectFormat.js";
import { shrinkForVision } from "../../src/image/shrinkForVision.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

describe("detectFormat", () => {
  it("detects PNG metadata", async () => {
    const buf = await readFile(fixture("green-disk.png"));

    await expect(detectFormat(buf)).resolves.toEqual({
      format: "png",
      extension: "png",
      width: 128,
      height: 128,
    });
  });

  it("maps JPEG to jpg extension", async () => {
    const buf = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: "#ffffff",
      },
    })
      .jpeg()
      .toBuffer();

    await expect(detectFormat(buf)).resolves.toMatchObject({
      format: "jpeg",
      extension: "jpg",
      width: 2,
      height: 2,
    });
  });

  it("detects WebP metadata", async () => {
    const buf = await sharp({
      create: {
        width: 3,
        height: 4,
        channels: 3,
        background: "#0000ff",
      },
    })
      .webp()
      .toBuffer();

    await expect(detectFormat(buf)).resolves.toMatchObject({
      format: "webp",
      extension: "webp",
      width: 3,
      height: 4,
    });
  });

  it("rejects corrupt image data", async () => {
    await expect(detectFormat(Buffer.from("not an image"))).rejects.toMatchObject({
      code: "image.decodeFailed",
    });
  });
});

describe("shrinkForVision", () => {
  it("returns image metadata without resizing when input already fits", async () => {
    const out = await shrinkForVision(await readFile(fixture("green-disk.png")), {
      width: 256,
      height: 256,
    });

    expect(out).toMatchObject({
      applied: false,
      originalWidth: 128,
      originalHeight: 128,
      outputWidth: 128,
      outputHeight: 128,
      format: "png",
    });
  });

  it("shrinks oversized images while preserving aspect ratio", async () => {
    const input = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: "#ff00ff",
      },
    })
      .png()
      .toBuffer();

    const out = await shrinkForVision(input, { width: 50, height: 50 });

    expect(out).toMatchObject({
      applied: true,
      originalWidth: 200,
      originalHeight: 100,
      outputWidth: 50,
      outputHeight: 25,
      format: "png",
    });
  });

  it("reports decode failures as LocalOpError", async () => {
    await expect(shrinkForVision(Buffer.from("bad"))).rejects.toMatchObject({
      errorType: "localOp",
      code: "image.decodeFailed",
    });
  });
});
