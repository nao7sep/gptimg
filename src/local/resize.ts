/**
 * Resize: plain, model-free resampling to a target size (any direction),
 * preserving alpha. This is the cheap counterpart to `upscale` — one sharp
 * resample, no ONNX model, no GBs of RAM. Use it to shrink (where a learned
 * model adds nothing — classical kernels are already optimal for downscaling)
 * or for quick enlargement where super-resolution quality isn't needed; reach
 * for `upscale` when enlarging small content and you want the learned ×4.
 */

import sharp from "sharp";
import { LocalOpError, toAbortError } from "../errors.js";
import type { ResampleKernel } from "../types.js";

export const RESIZE_DEFAULTS = {
  kernel: "lanczos3" as ResampleKernel,
} as const;

const KERNELS: readonly ResampleKernel[] = [
  "nearest",
  "cubic",
  "mitchell",
  "lanczos2",
  "lanczos3",
];
const MAX_TO_SIZE = 16384;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

/** Longer side := toSize, aspect preserved, each axis at least 1 px. */
function targetDims(
  width: number,
  height: number,
  toSize: number,
): { w: number; h: number } {
  if (width >= height) {
    return { w: toSize, h: Math.max(1, Math.round((toSize * height) / width)) };
  }
  return { w: Math.max(1, Math.round((toSize * width) / height)), h: toSize };
}

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
  if (!Number.isInteger(args.toSize) || args.toSize < 1 || args.toSize > MAX_TO_SIZE) {
    throw new LocalOpError(
      "args.invalid",
      `resize: to-size must be an integer in [1, ${MAX_TO_SIZE}]; got ${args.toSize}.`,
    );
  }
  if (!KERNELS.includes(kernel)) {
    throw new LocalOpError(
      "args.invalid",
      `resize: kernel must be one of ${KERNELS.join(", ")}; got ${kernel}.`,
    );
  }

  let meta;
  try {
    meta = await sharp(args.in).metadata();
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `resize: failed to read ${args.in}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (
    typeof meta.width !== "number" ||
    typeof meta.height !== "number" ||
    meta.width <= 0 ||
    meta.height <= 0
  ) {
    throw new LocalOpError(
      "image.noContent",
      `resize: could not determine dimensions of ${args.in}.`,
    );
  }
  throwIfAborted(signal);

  const { w, h } = targetDims(meta.width, meta.height, args.toSize);

  try {
    await sharp(args.in)
      .ensureAlpha()
      .resize(w, h, { fit: "fill", kernel })
      .png()
      .toFile(args.out);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `resize: failed to write ${args.out}: ${(err as Error).message}`,
      { cause: err },
    );
  }

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
