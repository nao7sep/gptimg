import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { readImageSize, resizeSingleChannel, writeImageFile, writeMaskPNG, writeRGBA } from "../../src/image/bridge.js";

describe("resizeSingleChannel", () => {
  it("upsizes single-channel data and stays one channel (exact dstW*dstH bytes)", async () => {
    // The reason this helper exists: sharp can widen a 1-channel raw buffer to
    // 3 channels mid-resize, which would triple the byte count and desync any
    // per-pixel recombine. The output must be exactly one byte per pixel.
    const src = new Uint8Array([0, 85, 170, 255]); // 2x2 gradient
    const out = await resizeSingleChannel(src, 2, 2, 8, 8);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(8 * 8);
  });

  it("downsizes a flat field to the exact target size, preserving the value", async () => {
    const src = new Uint8Array(16 * 16).fill(128);
    const out = await resizeSingleChannel(src, 16, 16, 4, 4, "nearest");
    expect(out.length).toBe(4 * 4);
    expect([...out].every((v) => v === 128)).toBe(true);
  });
});

describe("readImageSize", () => {
  it("reads an image's pixel size", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gptimg-bridge-"));
    try {
      const file = path.join(dir, "a.png");
      await sharp({ create: { width: 7, height: 3, channels: 4, background: "#000" } }).png().toFile(file);
      await expect(readImageSize(file, "resize")).resolves.toEqual({ width: 7, height: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names the verb when the file cannot be read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gptimg-bridge-"));
    try {
      const file = path.join(dir, "not-an-image.png");
      await writeFile(file, "plain text");
      await expect(readImageSize(file, "layer")).rejects.toMatchObject({
        code: "image.decodeFailed",
        message: expect.stringMatching(/^layer: failed to read /),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeImageFile", () => {
  it("writes the built pipeline to the file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gptimg-bridge-"));
    try {
      const file = path.join(dir, "out.png");
      await writeImageFile({ path: file }, "grid", () =>
        sharp({ create: { width: 2, height: 2, channels: 4, background: "#fff" } }).png(),
      );
      await expect(sharp(file).metadata()).resolves.toMatchObject({ width: 2, height: 2, format: "png" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a failure while building or writing as the verb's write failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gptimg-bridge-"));
    try {
      const failingBuild = writeImageFile({ path: path.join(dir, "out.png") }, "trim", () => {
        throw new Error("bad geometry");
      });
      await expect(failingBuild).rejects.toMatchObject({
        code: "image.writeFailed",
        message: expect.stringMatching(/^trim: failed to write .*bad geometry$/),
      });
      const missingFolder = writeImageFile({ path: path.join(dir, "missing", "out.png") }, "trim", () =>
        sharp({ create: { width: 1, height: 1, channels: 4, background: "#000" } }).png(),
      );
      await expect(missingFolder).rejects.toMatchObject({ code: "image.writeFailed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("image publication", () => {
  const onePixel = (): Sharp =>
    sharp({ create: { width: 1, height: 1, channels: 4, background: "#000" } }).png();

  it("refuses to replace a file without overwrite, even one that appeared after the verb's check", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gptimg-bridge-"));
    try {
      const file = path.join(dir, "out.png");
      await writeFile(file, "earlier writer");
      await expect(writeImageFile({ path: file }, "mask", onePixel)).rejects.toMatchObject({
        code: "output.exists",
      });
      await expect(writeRGBA(new Uint8Array(4), 1, 1, { path: file })).rejects.toMatchObject({
        code: "output.exists",
      });
      await expect(writeMaskPNG(new Uint8Array(1), 1, 1, { path: file })).rejects.toMatchObject({
        code: "output.exists",
      });
      await expect(readFile(file, "utf-8")).resolves.toBe("earlier writer");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the previous file intact when an overwrite fails to encode, and leaves no staging file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gptimg-bridge-"));
    try {
      const file = path.join(dir, "out.png");
      await writeImageFile({ path: file }, "upscale", onePixel);
      const before = await readFile(file);
      // A raw buffer too short for its declared size fails inside the encoder,
      // as an interrupted or failing libvips run would.
      await expect(writeRGBA(new Uint8Array(3), 4, 4, { path: file, overwrite: true })).rejects.toMatchObject({
        code: "image.writeFailed",
      });
      await expect(readFile(file)).resolves.toEqual(before);
      await expect(readdir(dir)).resolves.toEqual(["out.png"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing file with overwrite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gptimg-bridge-"));
    try {
      const file = path.join(dir, "out.png");
      await writeFile(file, "old");
      await writeMaskPNG(new Uint8Array([255]), 1, 1, { path: file, overwrite: true });
      await expect(sharp(file).metadata()).resolves.toMatchObject({ width: 1, height: 1, format: "png" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
