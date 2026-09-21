/**
 * Resize: plain, model-free resampling to a target size (any direction),
 * preserving alpha. This is the cheap counterpart to `upscale` — one sharp
 * resample, no ONNX model, no GBs of RAM. Use it to shrink (where a learned
 * model adds nothing — classical kernels are already optimal for downscaling)
 * or for quick enlargement where super-resolution quality isn't needed; reach
 * for `upscale` when enlarging small content and you want the learned ×4.
 */

import sharp from "sharp";
import { throwIfAborted } from "../errors.js";
import { readImageSize, writeImageFile } from "../image/bridge.js";
import { fitLongerSide } from "../image/aspect.js";
import type { ResampleKernel } from "../types.js";

export const RESIZE_DEFAULTS = {
  kernel: "lanczos3" as ResampleKernel,
} as const;

export interface ResizeRunArgs {
  in: string;
  out: string;
  toSize: number;
  kernel?: ResampleKernel;
}

export interface ResizeRunResult {
  output: string;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  toSize: number;
  kernel: ResampleKernel;
}

export async function runResize(
  args: ResizeRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<ResizeRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const kernel = args.kernel ?? RESIZE_DEFAULTS.kernel;

  const meta = await readImageSize(args.in, "resize");
  throwIfAborted(signal);

  const { w, h } = fitLongerSide(meta.width, meta.height, args.toSize);

  await writeImageFile(args.out, "resize", () =>
    sharp(args.in)
      .ensureAlpha()
      .resize(w, h, { fit: "fill", kernel })
      .png(),
  );

  return {
    output: args.out,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    width: w,
    height: h,
    toSize: args.toSize,
    kernel,
  };
}
