import sharp, { type Sharp } from "sharp";
import { LocalOpError } from "../errors.js";
import { writeFileAtomic } from "../internal/atomic-file.js";
import type { ResampleKernel } from "../types.js";

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

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

/** Where a local op publishes its image, and whether it may replace a file there. */
export interface ImageTarget {
  path: string;
  overwrite?: boolean | undefined;
}

/**
 * Publish encoded image bytes at `target.path` through the atomic write: staged
 * beside the target and then renamed, so an interrupted run never leaves a
 * truncated file under the final name or destroys the file it was replacing.
 * Without `overwrite` the publication is no-clobber, so a file that appeared
 * after the verb's up-front check is refused as `output.exists` rather than
 * replaced. Any other failure is `image.writeFailed` with `failure` as its
 * message prefix.
 */
async function publishImage(target: ImageTarget, bytes: Buffer, failure: string): Promise<void> {
  const overwrite = target.overwrite ?? false;
  try {
    await writeFileAtomic(target.path, bytes, { overwrite });
  } catch (err) {
    if (!overwrite && (err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LocalOpError("output.exists", `Output exists: ${target.path}. Set overwrite: true to allow.`, {
        cause: err,
      });
    }
    throw new LocalOpError("image.writeFailed", `${failure}: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Builds a sharp pipeline, encoding included, and publishes it at `target`
 * (see `publishImage`). Anything that fails while building, encoding or
 * writing it is the verb's `image.writeFailed`.
 */
export async function writeImageFile(target: ImageTarget, verb: string, build: () => Sharp): Promise<void> {
  const failure = `${verb}: failed to write ${target.path}`;
  let bytes: Buffer;
  try {
    bytes = await build().toBuffer();
  } catch (err) {
    throw new LocalOpError("image.writeFailed", `${failure}: ${(err as Error).message}`, { cause: err });
  }
  await publishImage(target, bytes, failure);
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
  target: ImageTarget,
): Promise<void> {
  const failure = `Failed to write image at ${target.path}`;
  let bytes: Buffer;
  try {
    bytes = await sharp(Buffer.from(data), {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();
  } catch (err) {
    throw new LocalOpError("image.writeFailed", `${failure}: ${(err as Error).message}`, { cause: err });
  }
  await publishImage(target, bytes, failure);
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
  target: ImageTarget,
): Promise<void> {
  const failure = `Failed to write mask at ${target.path}`;
  let bytes: Buffer;
  try {
    bytes = await sharp(Buffer.from(mask), {
      raw: { width, height, channels: 1 },
    })
      .png()
      .toBuffer();
  } catch (err) {
    throw new LocalOpError("image.writeFailed", `${failure}: ${(err as Error).message}`, { cause: err });
  }
  await publishImage(target, bytes, failure);
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
