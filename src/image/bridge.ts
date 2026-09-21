import sharp, { type PngOptions, type Sharp } from "sharp";
import { LocalOpError } from "../errors.js";
import type { ResampleKernel } from "../types.js";

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

/**
 * PNG encoding for files an app ships (`encode`, and `icon`'s loose PNGs): the
 * strongest lossless deflate, with adaptive row filtering. sharp's `effort` and `palette`
 * quantize, so neither is set. Working files keep sharp's faster default, since later verbs
 * read them straight back.
 */
export const DELIVERY_PNG_OPTIONS: PngOptions = { compressionLevel: 9, adaptiveFiltering: true };

/**
 * The pixel size of an image file, for the verb that needs it. A file sharp cannot read is
 * `image.decodeFailed`; one without positive dimensions is `image.noContent`.
 */
export async function readImageSize(path: string, verb: string): Promise<{ width: number; height: number }> {
  let meta;
  try {
    meta = await sharp(path).metadata();
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `${verb}: failed to read ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const { width, height } = meta;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    throw new LocalOpError("image.noContent", `${verb}: could not determine dimensions of ${path}.`);
  }
  return { width, height };
}

/**
 * Builds a sharp pipeline, encoding included, and writes it to `outPath`. Anything that fails
 * while building or writing it is the verb's `image.writeFailed`.
 */
export async function writeImageFile(outPath: string, verb: string, build: () => Sharp): Promise<void> {
  try {
    await build().toFile(outPath);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `${verb}: failed to write ${outPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

export async function loadRawRGBA(path: string): Promise<RawImage> {
  let out;
  try {
    out = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `Failed to decode image at ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const { data, info } = out;
  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    channels: 4,
  };
}

export async function writeRGBA(
  data: Uint8Array,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  try {
    await sharp(Buffer.from(data), {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toFile(outPath);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `Failed to write image at ${outPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Resize a single-channel (grayscale/alpha) raw buffer, returning exactly
 * `dstW * dstH` bytes. sharp can widen a 1-channel raw input to 3 channels while
 * resampling; `.toColourspace("b-w")` forces the output back to one channel so
 * the caller's per-pixel indexing stays correct.
 */
export async function resizeSingleChannel(
  data: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  kernel: ResampleKernel = "lanczos3",
): Promise<Uint8Array> {
  const out = await sharp(Buffer.from(data), {
    raw: { width: srcW, height: srcH, channels: 1 },
  })
    .resize(dstW, dstH, { fit: "fill", kernel })
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  return new Uint8Array(out);
}

/** Write a grayscale mask (0..255) as a single-channel PNG. */
export async function writeMaskPNG(
  mask: Uint8Array,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  try {
    await sharp(Buffer.from(mask), {
      raw: { width, height, channels: 1 },
    })
      .png()
      .toFile(outPath);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `Failed to write mask at ${outPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Load a grayscale mask PNG (0..255). If the file has multiple channels they
 * are flattened to luminance. Alpha channels in the file are ignored.
 */
export async function loadMaskPNG(path: string): Promise<RawImage> {
  let out;
  try {
    out = await sharp(path).grayscale().removeAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `Failed to decode mask at ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const { data, info } = out;
  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    channels: 1,
  };
}
