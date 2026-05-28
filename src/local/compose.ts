/**
 * Apply a mask to an image and write the result.
 *
 *   compose(image, mask)              → RGBA with mask in the alpha channel
 *   compose(image, mask, over=#rgb)   → flatten over a solid color (RGB output)
 *   compose(image, mask, over=path)   → flatten over another image
 *
 * Optional decontamination removes spill on partial-α pixels for a known key
 * color: the spill-tainted color is replaced by inpainted clean color from
 * confirmed-opaque neighbors. Off by default. Honest about its limits — it
 * only helps when the user knows what color was bleeding in.
 */

import { LocalOpError, toAbortError } from "../errors.js";
import { loadMaskPNG, loadRawRGBA, writeRGBA } from "../image/bridge.js";
import {
  SRGB_TO_LINEAR_LUT,
  analyzeKey,
  linearToSRGBByte,
  linearizeRGBA,
  parseHex,
} from "./chroma/spill.js";

export type ComposeOver =
  | { kind: "transparent" }
  | { kind: "color"; r: number; g: number; b: number }
  | { kind: "image"; path: string };

export interface ComposeArgs {
  in: string;
  mask: string;
  out: string;
  over?: ComposeOver;
  /** Decontaminate spill from this key color before compositing. */
  decontaminate?: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

export function parseOverColor(value: string): ComposeOver {
  const m = HEX_RE.exec(value);
  if (m) {
    const h = m[1]!;
    return {
      kind: "color",
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return { kind: "image", path: value };
}

/**
 * Inpaint clean foreground color into partial-α pixels by iterated 4-connected
 * dilation from confirmed-opaque sources (α = 255). Each pass averages
 * already-filled neighbors into unfilled cells. Stops when nothing changes.
 */
function inpaintForeground(
  linR: Float32Array,
  linG: Float32Array,
  linB: Float32Array,
  alpha: Uint8Array,
  width: number,
  height: number,
): { r: Float32Array; g: Float32Array; b: Float32Array; filled: Uint8Array } {
  const n = width * height;
  let curR = new Float32Array(n);
  let curG = new Float32Array(n);
  let curB = new Float32Array(n);
  let curFilled = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (alpha[p]! === 255) {
      curR[p] = linR[p]!;
      curG[p] = linG[p]!;
      curB[p] = linB[p]!;
      curFilled[p] = 1;
    }
  }
  let nextR = new Float32Array(n);
  let nextG = new Float32Array(n);
  let nextB = new Float32Array(n);
  let nextFilled = new Uint8Array(n);
  const maxIter = Math.max(width, height);
  for (let iter = 0; iter < maxIter; iter++) {
    nextR.set(curR);
    nextG.set(curG);
    nextB.set(curB);
    nextFilled.set(curFilled);
    let changed = false;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const p = row + x;
        if (curFilled[p]! !== 0) continue;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let count = 0;
        if (x > 0 && curFilled[p - 1]! !== 0) {
          sumR += curR[p - 1]!;
          sumG += curG[p - 1]!;
          sumB += curB[p - 1]!;
          count++;
        }
        if (x + 1 < width && curFilled[p + 1]! !== 0) {
          sumR += curR[p + 1]!;
          sumG += curG[p + 1]!;
          sumB += curB[p + 1]!;
          count++;
        }
        if (y > 0 && curFilled[p - width]! !== 0) {
          sumR += curR[p - width]!;
          sumG += curG[p - width]!;
          sumB += curB[p - width]!;
          count++;
        }
        if (y + 1 < height && curFilled[p + width]! !== 0) {
          sumR += curR[p + width]!;
          sumG += curG[p + width]!;
          sumB += curB[p + width]!;
          count++;
        }
        if (count > 0) {
          const inv = 1 / count;
          nextR[p] = sumR * inv;
          nextG[p] = sumG * inv;
          nextB[p] = sumB * inv;
          nextFilled[p] = 1;
          changed = true;
        }
      }
    }
    if (!changed) break;
    const tR = curR;
    const tG = curG;
    const tB = curB;
    const tF = curFilled;
    curR = nextR;
    curG = nextG;
    curB = nextB;
    curFilled = nextFilled;
    nextR = tR;
    nextG = tG;
    nextB = tB;
    nextFilled = tF;
  }
  return { r: curR, g: curG, b: curB, filled: curFilled };
}

async function loadOverImage(
  path: string,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const img = await loadRawRGBA(path);
  if (img.width !== width || img.height !== height) {
    throw new LocalOpError(
      "image.formatUnknown",
      `over-image size ${img.width}x${img.height} does not match input ${width}x${height}.`,
    );
  }
  return img.data;
}

export interface ComposeResult {
  output: string;
  width: number;
  height: number;
  over: ComposeOver["kind"];
}

export async function runCompose(
  args: ComposeArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<ComposeResult> {
  const { signal } = opts;
  throwIfAborted(signal);
  const image = await loadRawRGBA(args.in);
  throwIfAborted(signal);
  const mask = await loadMaskPNG(args.mask);
  if (mask.width !== image.width || mask.height !== image.height) {
    throw new LocalOpError(
      "image.formatUnknown",
      `mask size ${mask.width}x${mask.height} does not match image ${image.width}x${image.height}.`,
    );
  }
  const { width, height, data: rgba } = image;
  const n = width * height;

  let fgR: Float32Array | null = null;
  let fgG: Float32Array | null = null;
  let fgB: Float32Array | null = null;
  let fgFilled: Uint8Array | null = null;
  if (args.decontaminate) {
    const linear = parseHex(args.decontaminate).map((v) => SRGB_TO_LINEAR_LUT[v]!) as [
      number,
      number,
      number,
    ];
    const topology = analyzeKey(linear);
    if (topology !== null) {
      const { linR, linG, linB } = linearizeRGBA(rgba);
      const inpainted = inpaintForeground(linR, linG, linB, mask.data, width, height);
      fgR = inpainted.r;
      fgG = inpainted.g;
      fgB = inpainted.b;
      fgFilled = inpainted.filled;
    }
  }

  const over: ComposeOver = args.over ?? { kind: "transparent" };
  let overData: Uint8Array | null = null;
  if (over.kind === "image") {
    overData = await loadOverImage(over.path, width, height);
  }

  const out = new Uint8Array(n * 4);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = mask.data[p]!;
    let r: number;
    let g: number;
    let b: number;
    if (fgR && fgFilled && fgFilled[p] !== 0) {
      r = linearToSRGBByte(fgR[p]!);
      g = linearToSRGBByte(fgG![p]!);
      b = linearToSRGBByte(fgB![p]!);
    } else {
      r = rgba[i]!;
      g = rgba[i + 1]!;
      b = rgba[i + 2]!;
    }
    if (over.kind === "transparent") {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a;
    } else if (over.kind === "color") {
      const t = a / 255;
      out[i] = Math.round(r * t + over.r * (1 - t));
      out[i + 1] = Math.round(g * t + over.g * (1 - t));
      out[i + 2] = Math.round(b * t + over.b * (1 - t));
      out[i + 3] = 255;
    } else {
      const t = a / 255;
      const bgR = overData![i]!;
      const bgG = overData![i + 1]!;
      const bgB = overData![i + 2]!;
      out[i] = Math.round(r * t + bgR * (1 - t));
      out[i + 1] = Math.round(g * t + bgG * (1 - t));
      out[i + 2] = Math.round(b * t + bgB * (1 - t));
      out[i + 3] = 255;
    }
  }

  throwIfAborted(signal);
  await writeRGBA(out, width, height, args.out);
  return { output: args.out, width, height, over: over.kind };
}
