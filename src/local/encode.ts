/**
 * Encode: re-encode an image that already exists, such as a delivered file made before a
 * verb could write its own encoding. It writes PNG, always lossless, or WebP, lossy or
 * lossless, through the same encoder options every image-writing verb takes. It never
 * changes geometry, which `resize`, `trim` and `layer` do, and with `opaque` it refuses
 * transparency rather than flattening it onto a colour it would have to invent.
 */

import { stat } from "node:fs/promises";
import sharp from "sharp";
import { throwIfAborted } from "../errors.js";
import { readImageSize, writeImageFile } from "../image/bridge.js";
import type { EncodeFormat, EncodingArgs } from "../types.js";

export interface EncodeRunArgs extends EncodingArgs {
  in: string;
  out: string;
  /** Replace an existing file at `out`; otherwise publication is no-clobber. */
  overwrite?: boolean;
  format: EncodeFormat;
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

export async function runEncode(
  args: EncodeRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<EncodeRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const { width, height } = await readImageSize(args.in, "encode");
  throwIfAborted(signal);

  const lossless = args.format === "png" || (args.lossless ?? false);
  await writeImageFile({ path: args.out, overwrite: args.overwrite }, "encode", args, () => sharp(args.in));

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
