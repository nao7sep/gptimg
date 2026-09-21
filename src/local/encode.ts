/**
 * Encode: re-encode an image for delivery, the pipeline's last step. Every other verb writes
 * PNG, the lossless working format that later verbs read back; `encode` writes what an app
 * ships: PNG, always lossless, or WebP, lossy or lossless. Each encoder option is passed on
 * only when the caller sets it, so the encoder's own defaults apply otherwise. It never
 * changes geometry, which `resize`, `trim` and `layer` do before it, and with `opaque` it
 * refuses transparency rather than flattening it onto a colour it would have to invent.
 */

import { stat } from "node:fs/promises";
import sharp from "sharp";
import { LocalOpError, throwIfAborted } from "../errors.js";
import { loadRawRGBA, readImageSize, writeImageFile } from "../image/bridge.js";
import type { EncodeFormat } from "../types.js";

export interface EncodeRunArgs {
  in: string;
  out: string;
  format: EncodeFormat;
  quality?: number;
  lossless?: boolean;
  compressionLevel?: number;
  adaptiveFiltering?: boolean;
  opaque?: boolean;
}

export interface EncodeRunResult {
  output: string;
  format: EncodeFormat;
  width: number;
  height: number;
  alpha: boolean;
  lossless: boolean;
  sourceBytes: number;
  bytes: number;
}

/** Pixels whose alpha is below 255, which an opaque encoding would turn solid. */
async function countTranslucentPixels(path: string): Promise<number> {
  const { data } = await loadRawRGBA(path);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) count += 1;
  }
  return count;
}

export async function runEncode(
  args: EncodeRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<EncodeRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const { width, height } = await readImageSize(args.in, "encode");
  const opaque = args.opaque ?? false;
  if (opaque) {
    const translucent = await countTranslucentPixels(args.in);
    if (translucent > 0) {
      throw new LocalOpError(
        "image.notOpaque",
        `encode: ${args.in} has ${translucent} pixel(s) that are not fully opaque; an opaque encoding would turn them solid.`,
      );
    }
  }
  throwIfAborted(signal);

  const lossless = args.format === "png" || (args.lossless ?? false);
  await writeImageFile(args.out, "encode", () => {
    const pipeline = sharp(args.in);
    if (opaque) pipeline.removeAlpha();
    if (args.format === "png") {
      // Only lossless options are offered: sharp's `palette`, `quality` and `effort` quantize.
      return pipeline.png({
        ...(args.compressionLevel !== undefined && { compressionLevel: args.compressionLevel }),
        ...(args.adaptiveFiltering !== undefined && { adaptiveFiltering: args.adaptiveFiltering }),
      });
    }
    return pipeline.webp({
      ...(args.lossless !== undefined && { lossless: args.lossless }),
      ...(args.quality !== undefined && { quality: args.quality }),
    });
  });

  const [source, written, meta] = await Promise.all([stat(args.in), stat(args.out), sharp(args.out).metadata()]);
  return {
    output: args.out,
    format: args.format,
    width,
    height,
    alpha: meta.hasAlpha ?? false,
    lossless,
    sourceBytes: source.size,
    bytes: written.size,
  };
}
