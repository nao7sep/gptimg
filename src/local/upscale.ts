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
import { LocalOpError, throwIfAborted } from "../errors.js";
import { fitLongerSide } from "../image/aspect.js";
import { loadRawRGBA, readImageSize, resizeSingleChannel, writeRGBA } from "../image/bridge.js";
import type { Logger } from "../log/index.js";
import type { NetworkBudget } from "../network/defaults.js";
import type { ResampleKernel } from "../types.js";
import {
  runSwin2srX4,
  SWIN2SR_DEFAULT_TILE,
  SWIN2SR_SCALE,
} from "./models/swin2sr.js";

export const UPSCALE_DEFAULTS = {
  toSize: 1024,
  kernel: "lanczos3" as ResampleKernel,
  tile: SWIN2SR_DEFAULT_TILE,
} as const;

/**
 * The largest raw image sharp resamples by default (its `limitInputPixels`).
 * The ×4 model result goes into sharp as raw pixels for the final resample,
 * so a source whose ×4 result is larger than this would run the whole model
 * and then fail at the end.
 */
const SHARP_MAX_INPUT_PIXELS = 0x3fff * 0x3fff;

/**
 * Refuse a source whose ×4 model result the final resample cannot take, up
 * front, before the model loads or any tile runs.
 */
export function assertUpscaleSourceSize(width: number, height: number): void {
  const modelPixels = width * SWIN2SR_SCALE * height * SWIN2SR_SCALE;
  if (modelPixels > SHARP_MAX_INPUT_PIXELS) {
    const maxSourcePixels = Math.floor(SHARP_MAX_INPUT_PIXELS / (SWIN2SR_SCALE * SWIN2SR_SCALE));
    throw new LocalOpError(
      "image.tooLarge",
      `upscale: a ${width}×${height} source is too large; its ×4 result would be ` +
        `${width * SWIN2SR_SCALE}×${height * SWIN2SR_SCALE}. upscale takes sources up to ` +
        `${maxSourcePixels} pixels (just under 4096×4096); use resize for large images.`,
    );
  }
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
  /** Replace an existing file at `out`; otherwise publication is no-clobber. */
  overwrite?: boolean;
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

  const source = await readImageSize(args.in, "upscale");
  assertUpscaleSourceSize(source.width, source.height);
  throwIfAborted(signal);

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

    const alphaResized = await resizeSingleChannel(
      alpha,
      width,
      height,
      finalW,
      finalH,
      kernel,
    );

    const rgba = new Uint8Array(finalW * finalH * 4);
    for (let p = 0, s = 0, d = 0; p < finalW * finalH; p++, s += 3, d += 4) {
      rgba[d] = rgbResized[s]!;
      rgba[d + 1] = rgbResized[s + 1]!;
      rgba[d + 2] = rgbResized[s + 2]!;
      rgba[d + 3] = alphaResized[p]!;
    }
    await writeRGBA(rgba, finalW, finalH, { path: args.out, overwrite: args.overwrite });
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
