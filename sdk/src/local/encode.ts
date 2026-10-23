/**
 * Encode: re-encode an image that already exists, such as a delivered file made before a
 * verb could write its own encoding, or an export. It writes PNG, always lossless, WebP,
 * lossy or lossless, or JPEG, through the same encoder options every image-writing verb
 * takes. It never changes geometry, which `resize`, `trim` and `layer` do. Transparency is
 * filled only with a `background` the caller chose; with `opaque`, or for JPEG without one,
 * a translucent pixel is refused rather than flattened onto a colour it would have to invent.
 */

import { stat } from "node:fs/promises";
import sharp from "../image/sharp.ts";
import { throwIfAborted } from "../errors.ts";
import { decodeImage, readImageSize, writeImageFile } from "../image/bridge.ts";
import type { EncodeFormat, EncodingArgs } from "../types.ts";

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
  await writeImageFile({ path: args.out, overwrite: args.overwrite, signal, source: args.in }, "encode", args, () => decodeImage(args.in));

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
