import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEncode } from "../../src/local/encode.js";

/** A noisy RGBA image, so compression has something to work on, with a transparent border. */
function noisyRGBA(width: number, height: number, alpha: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = next();
      data[i + 1] = (x * 4) % 256;
      data[i + 2] = (y * 4) % 256;
      data[i + 3] = alpha(x, y);
    }
  }
  return data;
}

async function writeRaw(filePath: string, width: number, height: number, rgba: Uint8Array): Promise<void> {
  await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

async function rawRGBA(filePath: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp(filePath).ensureAlpha().raw().toBuffer());
}

describe("runEncode", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-encode-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const border = (x: number, y: number) => (x < 4 || y < 4 || x > 59 || y > 59 ? 0 : 255);

  it("writes a PNG at the encoder's defaults when no option is set, every pixel unchanged", async () => {
    const input = path.join(tmp, "in.png");
    await writeRaw(input, 64, 64, noisyRGBA(64, 64, border));
    const out = path.join(tmp, "out.png");

    const res = await runEncode({ in: input, out, format: "png" });

    expect(await rawRGBA(out)).toEqual(await rawRGBA(input));
    expect(res.bytes).toBe((await sharp(input).png().toBuffer()).length);
    expect(res).toMatchObject({ format: "png", width: 64, height: 64, alpha: true, lossless: true });
    expect((await sharp(out).metadata()).format).toBe("png");
  });

  it("applies PNG compression options only when set, every pixel unchanged", async () => {
    const input = path.join(tmp, "in.png");
    await writeRaw(input, 64, 64, noisyRGBA(64, 64, border));
    const out = path.join(tmp, "out.png");

    const res = await runEncode({ in: input, out, format: "png", compressionLevel: 9, adaptiveFiltering: true });

    expect(await rawRGBA(out)).toEqual(await rawRGBA(input));
    expect(res.bytes).toBe(
      (await sharp(input).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()).length,
    );
  });

  it("writes lossless WebP keeping every visible pixel exactly", async () => {
    const input = path.join(tmp, "in.png");
    await writeRaw(input, 64, 64, noisyRGBA(64, 64, border));
    const out = path.join(tmp, "out.webp");

    const res = await runEncode({ in: input, out, format: "webp", lossless: true });

    const source = await rawRGBA(input);
    const written = await rawRGBA(out);
    for (let i = 0; i < source.length; i += 4) {
      expect(written[i + 3]).toBe(source[i + 3]);
      if (source[i + 3]! > 0) expect([...written.subarray(i, i + 3)]).toEqual([...source.subarray(i, i + 3)]);
    }
    expect(res).toMatchObject({ format: "webp", alpha: true, lossless: true });
  });

  it("writes lossy WebP at the encoder's default quality unless one is set, keeping the alpha channel", async () => {
    const input = path.join(tmp, "in.png");
    await writeRaw(input, 64, 64, noisyRGBA(64, 64, border));
    const out = path.join(tmp, "out.webp");

    const res = await runEncode({ in: input, out, format: "webp" });

    expect(res.bytes).toBe((await sharp(input).webp().toBuffer()).length);
    const lower = await runEncode({ in: input, out: path.join(tmp, "low.webp"), format: "webp", quality: 30 });
    expect(lower.bytes).toBe((await sharp(input).webp({ quality: 30 }).toBuffer()).length);
    expect(res).toMatchObject({ format: "webp", alpha: true, lossless: false });
    expect(await sharp(out).metadata()).toMatchObject({ format: "webp", hasAlpha: true });
    const written = await rawRGBA(out);
    expect(written[3]).toBe(0);
    expect(written[(32 * 64 + 32) * 4 + 3]).toBe(255);
  });

  it("writes an opaque image with no alpha channel and its colours unchanged", async () => {
    const input = path.join(tmp, "in.png");
    await writeRaw(input, 32, 32, noisyRGBA(32, 32, () => 255));
    const out = path.join(tmp, "out.png");

    const res = await runEncode({ in: input, out, format: "png", opaque: true });

    expect(res.alpha).toBe(false);
    expect(await sharp(out).metadata()).toMatchObject({ channels: 3, hasAlpha: false });
    expect(await rawRGBA(out)).toEqual(await rawRGBA(input));
  });

  it("refuses an opaque encoding of an image with a single translucent pixel, writing nothing", async () => {
    const input = path.join(tmp, "in.png");
    await writeRaw(input, 32, 32, noisyRGBA(32, 32, (x, y) => (x === 5 && y === 7 ? 254 : 255)));
    const out = path.join(tmp, "out.png");

    await expect(runEncode({ in: input, out, format: "png", opaque: true })).rejects.toMatchObject({
      code: "image.notOpaque",
      message: expect.stringContaining("1 pixel(s)"),
    });
    expect(existsSync(out)).toBe(false);
  });

  it("reports an unreadable input as a decode failure", async () => {
    const input = path.join(tmp, "in.png");
    await writeFile(input, "not an image");
    await expect(runEncode({ in: input, out: path.join(tmp, "out.png"), format: "png" })).rejects.toMatchObject({
      code: "image.decodeFailed",
    });
  });

  it("stops before reading when the signal has already aborted", async () => {
    const input = path.join(tmp, "in.png");
    await writeRaw(input, 8, 8, noisyRGBA(8, 8, () => 255));
    const controller = new AbortController();
    controller.abort();
    await expect(
      runEncode({ in: input, out: path.join(tmp, "out.png"), format: "png" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
