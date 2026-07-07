import sharp from "sharp";
import { LocalOpError } from "../errors.js";
import type { ResampleKernel } from "../types.js";

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
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
