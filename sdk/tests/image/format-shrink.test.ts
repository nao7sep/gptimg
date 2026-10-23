import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { detectFormat } from "../../src/image/detectFormat.ts";
import { shrinkForVision } from "../../src/image/shrinkForVision.ts";

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
      code: "image.undecodable",
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

  it.each(["jpeg", "png", "webp"] as const)("keeps the original %s bytes when no transform is needed", async (format) => {
    const input = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#ed8142" } })
      .withMetadata({ orientation: 6 })[format]().toBuffer();
    const out = await shrinkForVision(input);
    expect(out.buffer).toBe(input);
    expect((await sharp(out.buffer).metadata()).orientation).toBe(6);
    expect(out.applied).toBe(false);
  });

  it("rejects truncated pixels even when dimensions can be read and no shrink is needed", async () => {
    const input = (await readFile(fixture("green-disk.png"))).subarray(0, 100);
    await expect(sharp(input).metadata()).resolves.toMatchObject({ width: 128 });
    await expect(shrinkForVision(input)).rejects.toMatchObject({ code: "image.undecodable" });
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

  it("reports decode failures as GptImgError", async () => {
    await expect(shrinkForVision(Buffer.from("bad"))).rejects.toMatchObject({
      code: "image.undecodable",
    });
  });
});
