import sharp, { type Sharp } from "sharp";
import { GptImgError, fsError, processingError } from "../errors.ts";
import { writeOutputBytes } from "../internal/output-files.ts";
import type { EncodingArgs, PngEncodingArgs, ResampleKernel } from "../types.ts";
import { readCaptureMetadata, withCaptureMetadata, type CaptureMetadata } from "./capture.ts";

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

/**
 * The pixel size of an image file, for the verb that needs it. A file sharp cannot read is
 * `image.undecodable`; one without positive dimensions is `image.noContent`.
 */
export async function readImageSize(path: string, verb: string): Promise<{ width: number; height: number }> {
  let meta;
  try {
    meta = await sharp(path).metadata();
  } catch (err) {
    throw inputImageError(err, `${verb}: failed to read`, path);
  }
  const { width, height } = meta;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    throw new GptImgError("image.noContent", `${verb}: could not determine dimensions of ${path}.`);
  }
  return { width, height };
}

/**
 * A failure reading or decoding an input image with sharp, as the error naming
 * its cause: a missing or unreadable file is the filesystem's (sharp reports a
 * missing file without an errno), anything else is an image sharp cannot
 * decode. Nothing has taken effect.
 */
export function inputImageError(err: unknown, what: string, subject: string): Error {
  if (err instanceof GptImgError || (err as { name?: unknown } | null)?.name === "RefusalSignal") return err as Error;
  const message = (err as Error)?.message ?? String(err);
  if (/^Input file is missing/.test(message)) {
    return new GptImgError("fs.notFound", `${what} ${subject}: ${message}`, { cause: err, subject, details: { errno: "ENOENT" } });
  }
  const errno = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string" && /^E[A-Z]+$/.test(errno)) return fsError(err, what, subject);
  return new GptImgError("image.undecodable", `${what} ${subject}: ${message}`, { cause: err, subject });
}

/**
 * Where a local op publishes its image, whether it may replace a file there,
 * and the one source image it is derived from, whose capture facts it keeps.
 */
export interface ImageTarget {
  path: string;
  overwrite?: boolean | undefined;
  source?: string | undefined;
}

/**
 * Publish encoded image bytes at `target.path` through the atomic write: staged
 * beside the target and then renamed, so an interrupted run never leaves a
 * truncated file under the final name or destroys the file it was replacing.
 * Without `overwrite` the publication is no-clobber, so a file that appeared
 * after the verb's up-front check is refused as `output.exists` rather than
 * replaced. Any other failure names the filesystem's cause.
 */
async function publishImage(target: ImageTarget, bytes: Buffer, failure: string): Promise<void> {
  await writeOutputBytes(target.path, bytes, target.overwrite ?? false, failure);
}

/**
 * Encodes a sharp pipeline's pixels as the caller asked, passing sharp only the options the
 * caller set (PLAYBOOK, "Leave a library's defaults to the library"). PNG offers only the
 * lossless options, because sharp's `palette`, `quality` and `effort` quantize. With
 * `background` transparency is filled with the caller's colour. With `opaque`, or for JPEG without
 * `background`, the pixels are checked first and a translucent one is refused as
 * `image.notOpaque`, never flattened onto a colour the SDK would invent. `failure` prefixes that refusal's message. `capture` is written into the encoded
 * image last, so it survives the opaque check's re-read.
 */
export async function encodeImage(
  pipeline: Sharp,
  encoding: EncodingArgs,
  failure: string,
  capture?: CaptureMetadata,
): Promise<Buffer> {
  let image = pipeline;
  if (encoding.background !== undefined) {
    // The caller chose the colour; flattening removes the alpha channel.
    image = pipeline.flatten({ background: encoding.background });
  } else if (encoding.opaque === true || encoding.format === "jpeg") {
    // The pixels are rendered once to a lossless PNG and re-read, because a pipeline that already
    // called `ensureAlpha` keeps its alpha channel through a later `removeAlpha`. A PNG rather than
    // raw pixels keeps the source's density, so an opaque file's bytes stay what they were.
    const rendered = await pipeline.clone().ensureAlpha().png().toBuffer();
    const data = await sharp(rendered).raw().toBuffer();
    let translucent = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < 255) translucent += 1;
    }
    if (translucent > 0) {
      throw new GptImgError(
        "image.notOpaque",
        encoding.format === "jpeg" && encoding.opaque !== true
          ? `${failure}: ${translucent} pixel(s) are not fully opaque, and JPEG holds no transparency; pass background to fill it.`
          : `${failure}: ${translucent} pixel(s) are not fully opaque; an opaque encoding would turn them solid.`,
      );
    }
    image = sharp(rendered).removeAlpha();
  }
  if (encoding.format === "jpeg") {
    image.jpeg({ ...(encoding.quality !== undefined && { quality: encoding.quality }) });
  } else if (encoding.format === "webp") {
    image.webp({
      ...(encoding.lossless !== undefined && { lossless: encoding.lossless }),
      ...(encoding.quality !== undefined && { quality: encoding.quality }),
      ...(encoding.smartSubsample !== undefined && { smartSubsample: encoding.smartSubsample }),
    });
  } else {
    image.png({
      ...(encoding.compressionLevel !== undefined && { compressionLevel: encoding.compressionLevel }),
      ...(encoding.adaptiveFiltering !== undefined && { adaptiveFiltering: encoding.adaptiveFiltering }),
    });
  }
  if (capture) withCaptureMetadata(image, capture);
  return image.toBuffer();
}

/**
 * Builds the sharp pipeline, encodes it with the capture facts of `target.source` (see
 * `encodeImage`) and publishes it at `target` (see `publishImage`). Anything that fails while
 * building or encoding names its cause, with `failure` as its message prefix; a refusal
 * the encoding itself raises keeps its code.
 */
async function encodeAndPublish(
  target: ImageTarget,
  failure: string,
  encoding: EncodingArgs,
  build: () => Sharp,
): Promise<void> {
  let bytes: Buffer;
  try {
    const capture = target.source === undefined ? undefined : await readCaptureMetadata(target.source);
    bytes = await encodeImage(build(), encoding, failure, capture);
  } catch (err) {
    // Encoding happens before any write, so nothing has taken effect yet.
    throw processingError(err, failure, target.path, "none");
  }
  await publishImage(target, bytes, failure);
}

/**
 * Builds a sharp pipeline, without its encoding, and writes it at `target` encoded as
 * `encoding` asks.
 */
export async function writeImageFile(
  target: ImageTarget,
  verb: string,
  encoding: EncodingArgs,
  build: () => Sharp,
): Promise<void> {
  await encodeAndPublish(target, `${verb}: failed to write ${target.path}`, encoding, build);
}

export async function loadRawRGBA(path: string): Promise<RawImage> {
  let out;
  try {
    out = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw inputImageError(err, "Failed to decode image at", path);
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
  encoding: EncodingArgs,
): Promise<void> {
  await encodeAndPublish(target, `Failed to write image at ${target.path}`, encoding, () =>
    sharp(Buffer.from(data), { raw: { width, height, channels: 4 } }),
  );
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

/** Write a grayscale mask (0..255) as a single-channel PNG, at the lossless options given. */
export async function writeMaskPNG(
  mask: Uint8Array,
  width: number,
  height: number,
  target: ImageTarget,
  encoding: PngEncodingArgs,
): Promise<void> {
  await encodeAndPublish(target, `Failed to write mask at ${target.path}`, encoding, () =>
    sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }),
  );
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
    throw inputImageError(err, "Failed to decode mask at", path);
  }
  const { data, info } = out;
  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    channels: 1,
  };
}
