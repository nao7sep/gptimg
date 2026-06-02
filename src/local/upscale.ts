/**
 * Upscale: learned ×4 super-resolution (Swin2SR), then resample to a target
 * size with a selectable kernel. The model is RGB-only, so alpha is resampled
 * separately and recombined — transparency survives, which matters in the icon
 * pipeline where the input is a trimmed RGBA cutout:
 *
 *   trim --square … → upscale --to-size 1024 → backplate … → layer …
 *
 * The model runs at the source's native size (×4), tiling internally to bound
 * memory; the result is then resampled to `toSize` (longer side, aspect
 * preserved). To hit 2×, run ×4 and let the downscale halve it — there is no
 * native ×2 path, by design.
 */

import sharp from "sharp";
import { LocalOpError, toAbortError } from "../errors.js";
import { fitLongerSide } from "../image/aspect.js";
import { loadRawRGBA, writeRGBA } from "../image/bridge.js";
import type { Logger } from "../log/index.js";
import type { NetworkBudget } from "../network/defaults.js";
import type { ResampleKernel } from "../types.js";
import {
  runSwin2srX4,
  SWIN2SR_DEFAULT_TILE,
  SWIN2SR_MIN_TILE,
} from "./models/swin2sr.js";

export const UPSCALE_DEFAULTS = {
  toSize: 1024,
  kernel: "lanczos3" as ResampleKernel,
  tile: SWIN2SR_DEFAULT_TILE,
} as const;

const KERNELS: readonly ResampleKernel[] = [
  "nearest",
  "cubic",
  "mitchell",
  "lanczos2",
  "lanczos3",
];
// Lower than resize's cap (16384): upscale runs the ×4 model + holds a 4×
// intermediate, so it is far more memory-heavy per output pixel.
const MAX_TO_SIZE = 8192;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

/**
 * ×4 RGB upscaler over interleaved-RGB pixels. Injectable so the resample +
 * alpha-recombine pipeline is testable without loading the ONNX model.
 */
export type RgbUpscaler = (
  rgb: Uint8Array,
  width: number,
  height: number,
) => Promise<{ rgb: Uint8Array; width: number; height: number; tiles?: number }>;

export interface UpscaleRunArgs {
  in: string;
  out: string;
  toSize?: number;
  kernel?: ResampleKernel;
  tile?: number;
}

export interface UpscaleRunResult {
  output: string;
  sourceWidth: number;
  sourceHeight: number;
  modelWidth: number;
  modelHeight: number;
  width: number;
  height: number;
  toSize: number;
  kernel: ResampleKernel;
  tile: number;
  tiles: number;
}

function splitRGBA(
  data: Uint8Array,
  n: number,
): { rgb: Uint8Array; alpha: Uint8Array } {
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  for (let p = 0, s = 0, d = 0; p < n; p++, s += 4, d += 3) {
    rgb[d] = data[s]!;
    rgb[d + 1] = data[s + 1]!;
    rgb[d + 2] = data[s + 2]!;
    alpha[p] = data[s + 3]!;
  }
  return { rgb, alpha };
}

export async function runUpscale(
  args: UpscaleRunArgs,
  cacheDir: string,
  opts: {
    signal?: AbortSignal | undefined;
    budget?: NetworkBudget;
    logger?: Logger;
    /** Override the ×4 model (tests inject a deterministic upscaler). */
    upscaler?: RgbUpscaler;
  } = {},
): Promise<UpscaleRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const toSize = args.toSize ?? UPSCALE_DEFAULTS.toSize;
  const kernel = args.kernel ?? UPSCALE_DEFAULTS.kernel;
  const tile = args.tile ?? UPSCALE_DEFAULTS.tile;

  if (!Number.isInteger(toSize) || toSize < 1 || toSize > MAX_TO_SIZE) {
    throw new LocalOpError(
      "args.invalid",
      `upscale: to-size must be an integer in [1..${MAX_TO_SIZE}]; got ${toSize}.`,
    );
  }
  if (!KERNELS.includes(kernel)) {
    throw new LocalOpError(
      "args.invalid",
      `upscale: kernel must be one of ${KERNELS.join(", ")}; got ${kernel}.`,
    );
  }
  if (!Number.isInteger(tile) || tile < SWIN2SR_MIN_TILE) {
    throw new LocalOpError(
      "args.invalid",
      `upscale: tile must be an integer >= ${SWIN2SR_MIN_TILE}; got ${tile}.`,
    );
  }

  const { data, width, height } = await loadRawRGBA(args.in);
  throwIfAborted(signal);
  const { rgb, alpha } = splitRGBA(data, width * height);

  const upscaler: RgbUpscaler =
    opts.upscaler ??
    ((r, w, h) =>
      runSwin2srX4(r, w, h, cacheDir, {
        tile,
        signal,
        budget: opts.budget,
        logger: opts.logger,
      }));

  const up = await upscaler(rgb, width, height);
  throwIfAborted(signal);

  const { w: finalW, h: finalH } = fitLongerSide(width, height, toSize);

  try {
    const rgbResized = await sharp(Buffer.from(up.rgb), {
      raw: { width: up.width, height: up.height, channels: 3 },
    })
      .resize(finalW, finalH, { fit: "fill", kernel })
      .raw()
      .toBuffer();

    const alphaResized = await sharp(Buffer.from(alpha), {
      raw: { width, height, channels: 1 },
    })
      .resize(finalW, finalH, { fit: "fill", kernel })
      // Force single-channel output: sharp can widen a 1-channel raw buffer to
      // 3 channels during resampling, which would desync the RGBA recombine
      // below (same lesson as birefnet.ts:resizeAlphaUp).
      .toColourspace("b-w")
      .raw()
      .toBuffer();

    const rgba = new Uint8Array(finalW * finalH * 4);
    for (let p = 0, s = 0, d = 0; p < finalW * finalH; p++, s += 3, d += 4) {
      rgba[d] = rgbResized[s]!;
      rgba[d + 1] = rgbResized[s + 1]!;
      rgba[d + 2] = rgbResized[s + 2]!;
      rgba[d + 3] = alphaResized[p]!;
    }
    await writeRGBA(rgba, finalW, finalH, args.out);
  } catch (err) {
    if (err instanceof LocalOpError) throw err;
    throw new LocalOpError(
      "image.writeFailed",
      `upscale: failed to resample/write ${args.out}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return {
    output: args.out,
    sourceWidth: width,
    sourceHeight: height,
    modelWidth: up.width,
    modelHeight: up.height,
    width: finalW,
    height: finalH,
    toSize,
    kernel,
    tile,
    tiles: up.tiles ?? 1,
  };
}
