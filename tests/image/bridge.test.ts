import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { readImageSize, resizeSingleChannel, writeImageFile } from "../../src/image/bridge.js";

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
      await writeImageFile(file, "grid", () =>
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
      const failingBuild = writeImageFile(path.join(dir, "out.png"), "trim", () => {
        throw new Error("bad geometry");
      });
      await expect(failingBuild).rejects.toMatchObject({
        code: "image.writeFailed",
        message: expect.stringMatching(/^trim: failed to write .*bad geometry$/),
      });
      const missingFolder = writeImageFile(path.join(dir, "missing", "out.png"), "trim", () =>
        sharp({ create: { width: 1, height: 1, channels: 4, background: "#000" } }).png(),
      );
      await expect(missingFolder).rejects.toMatchObject({ code: "image.writeFailed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
