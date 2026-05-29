/**
 * Trim: crop an RGBA image to its alpha bounding box and re-pad by a relative
 * margin. Optionally extend the shorter axis with transparent pixels so the
 * output is square (useful when feeding the result into the icon pipeline,
 * which expects a square content layer for the squircle backplate).
 *
 * "Relative" margin = a fraction of the longer bbox side. This gives every
 * stamp/icon the same *visual* breathing room regardless of raw subject size.
 */

import sharp from "sharp";
import { LocalOpError, toAbortError } from "../errors.js";
import { loadRawRGBA } from "../image/bridge.js";
import type { AlphaBBox } from "../types.js";

export const TRIM_DEFAULTS = {
  margin: 0.08,
  square: false,
} as const;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

/**
 * Tightest rect of pixels where alpha > 0. Returns null when the entire image
 * is fully transparent. Linear scan, O(width * height).
 */
export function computeAlphaBBox(
  rgba: Uint8Array,
  width: number,
  height: number,
): AlphaBBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const a = rgba[(row + x) * 4 + 3]!;
      if (a > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface TrimRunArgs {
  in: string;
  out: string;
  margin?: number;
  square?: boolean;
}

export interface TrimRunResult {
  output: string;
  bbox: AlphaBBox;
  margin: number;
  marginPx: number;
  width: number;
  height: number;
  square: boolean;
}

export async function runTrim(
  args: TrimRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<TrimRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const margin = args.margin ?? TRIM_DEFAULTS.margin;
  const square = args.square ?? TRIM_DEFAULTS.square;
  if (!Number.isFinite(margin) || margin < 0 || margin > 1) {
    throw new LocalOpError(
      "args.invalid",
      `trim: margin must be a number in [0, 1]; got ${margin}.`,
    );
  }

  const { data, width, height } = await loadRawRGBA(args.in);
  throwIfAborted(signal);
  const bbox = computeAlphaBBox(data, width, height);
  if (!bbox) {
    throw new LocalOpError(
      "image.noContent",
      `trim: ${args.in} is fully transparent; nothing to crop.`,
    );
  }

  const marginPx = Math.round(margin * Math.max(bbox.width, bbox.height));
  let padTop = marginPx;
  let padBottom = marginPx;
  let padLeft = marginPx;
  let padRight = marginPx;
  if (square) {
    const contentW = bbox.width + 2 * marginPx;
    const contentH = bbox.height + 2 * marginPx;
    const finalSize = Math.max(contentW, contentH);
    const extraW = finalSize - contentW;
    const extraH = finalSize - contentH;
    padLeft += Math.floor(extraW / 2);
    padRight += Math.ceil(extraW / 2);
    padTop += Math.floor(extraH / 2);
    padBottom += Math.ceil(extraH / 2);
  }

  const finalW = bbox.width + padLeft + padRight;
  const finalH = bbox.height + padTop + padBottom;

  try {
    const pipeline = sharp(args.in).extract({
      left: bbox.x,
      top: bbox.y,
      width: bbox.width,
      height: bbox.height,
    });
    if (padLeft || padRight || padTop || padBottom) {
      pipeline.extend({
        top: padTop,
        bottom: padBottom,
        left: padLeft,
        right: padRight,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
    }
    await pipeline.png().toFile(args.out);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `trim: failed to write ${args.out}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return {
    output: args.out,
    bbox,
    margin,
    marginPx,
    width: finalW,
    height: finalH,
    square,
  };
}
