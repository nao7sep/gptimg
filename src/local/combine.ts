/**
 * Set operations and a simple feather on grayscale alpha masks.
 *
 * Inputs are loaded as single-channel PNGs (or any image flattened to luma).
 * Outputs are single-channel grayscale PNGs the same size as the input(s).
 *
 *   union     a | b   → pixelwise max
 *   intersect a & b   → pixelwise min
 *   subtract  a - b   → clamp(a - b, 0, 255)
 *   invert    !a      → 255 - a
 *   feather   a       → separable 3×3 box blur, `radius` passes
 */

import { LocalOpError, toAbortError } from "../errors.js";
import { loadMaskPNG, writeMaskPNG } from "../image/bridge.js";
import type { CombineOp } from "../enums.js";

export interface CombineArgs {
  op: CombineOp;
  inputs: string[];
  out: string;
  /** Number of 3×3 box-blur passes for `feather`. Ignored for other ops. */
  radius?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

async function loadSameSize(paths: string[]): Promise<{
  buffers: Uint8Array[];
  width: number;
  height: number;
}> {
  const masks = await Promise.all(paths.map((p) => loadMaskPNG(p)));
  const first = masks[0]!;
  for (let i = 1; i < masks.length; i++) {
    if (masks[i]!.width !== first.width || masks[i]!.height !== first.height) {
      throw new LocalOpError(
        "image.sizeMismatch",
        `combine inputs differ in size: ${paths[0]} is ${first.width}x${first.height}, ${paths[i]} is ${masks[i]!.width}x${masks[i]!.height}.`,
      );
    }
  }
  return {
    buffers: masks.map((m) => m.data),
    width: first.width,
    height: first.height,
  };
}

function boxBlurInPlace(
  buf: Uint8Array,
  width: number,
  height: number,
  passes: number,
): void {
  if (passes <= 0) return;
  const tmp = new Uint8Array(buf.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const p = row + x;
        let sum = buf[p]!;
        let count = 1;
        if (x > 0) {
          sum += buf[p - 1]!;
          count++;
        }
        if (x + 1 < width) {
          sum += buf[p + 1]!;
          count++;
        }
        tmp[p] = Math.round(sum / count);
      }
    }
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const p = row + x;
        let sum = tmp[p]!;
        let count = 1;
        if (y > 0) {
          sum += tmp[p - width]!;
          count++;
        }
        if (y + 1 < height) {
          sum += tmp[p + width]!;
          count++;
        }
        buf[p] = Math.round(sum / count);
      }
    }
  }
}

export interface CombineResult {
  output: string;
  width: number;
  height: number;
  op: CombineOp;
}

export async function runCombine(
  args: CombineArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<CombineResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  let out: Uint8Array;
  let width: number;
  let height: number;

  if (args.op === "union" || args.op === "intersect" || args.op === "subtract") {
    const loaded = await loadSameSize(args.inputs);
    width = loaded.width;
    height = loaded.height;
    const [a, b] = loaded.buffers;
    out = new Uint8Array(a!.length);
    if (args.op === "union") {
      for (let p = 0; p < a!.length; p++) {
        out[p] = a![p]! > b![p]! ? a![p]! : b![p]!;
      }
    } else if (args.op === "intersect") {
      for (let p = 0; p < a!.length; p++) {
        out[p] = a![p]! < b![p]! ? a![p]! : b![p]!;
      }
    } else {
      for (let p = 0; p < a!.length; p++) {
        const v = a![p]! - b![p]!;
        out[p] = v < 0 ? 0 : v;
      }
    }
  } else if (args.op === "invert") {
    const loaded = await loadSameSize(args.inputs);
    width = loaded.width;
    height = loaded.height;
    const a = loaded.buffers[0]!;
    out = new Uint8Array(a.length);
    for (let p = 0; p < a.length; p++) out[p] = 255 - a[p]!;
  } else {
    const radius = args.radius ?? 1;
    const loaded = await loadSameSize(args.inputs);
    width = loaded.width;
    height = loaded.height;
    out = new Uint8Array(loaded.buffers[0]!);
    boxBlurInPlace(out, width, height, Math.floor(radius));
  }

  throwIfAborted(signal);
  await writeMaskPNG(out, width, height, args.out);
  return { output: args.out, width, height, op: args.op };
}
