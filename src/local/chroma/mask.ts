/**
 * Chroma mask producer. Input: an image plus a key spec (auto / from-sidecar /
 * #rrggbb). Output: a grayscale alpha mask the same size as the image, where
 * 255 = opaque subject and 0 = transparent background.
 *
 * Algorithm:
 *   1. Resolve the key color (auto = mean of border pixels).
 *   2. Per-pixel spill → alpha via spill.ts.
 *   3. If preserveInterior, flood-fill from the border across "transparent"
 *      pixels; any α≈0 pixel not reached by the fill is interior key-colored
 *      subject content and gets forced back to opaque.
 *
 * No LAB Gaussian, no connected components, no region scoring. Single pass.
 */

import { LocalOpError, toAbortError } from "../../errors.js";
import { loadRawRGBA } from "../../image/bridge.js";
import { CHROMA_DEFAULTS } from "./defaults.js";
import { loadKeyFromSidecar } from "./sidecar-key.js";
import {
  analyzeKey,
  linearizeRGBA,
  parseHex,
  SRGB_TO_LINEAR_LUT,
  spillAlpha,
  type KeyTopology,
} from "./spill.js";

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

export type ChromaKeySpec = "auto" | "from-sidecar" | string;
export type ChromaKeySource = "auto" | "sidecar" | "explicit";

export interface ChromaMaskOptions {
  key?: ChromaKeySpec;
  preserveInterior?: boolean;
  borderSample?: number;
  /** Spill ratio at which near-key pixels saturate to α=0. Defaults to CHROMA_DEFAULTS.saturationRatio. */
  saturationRatio?: number;
}

export interface ChromaMaskStats {
  method: "chroma";
  key: string;
  keySource: ChromaKeySource;
  preserveInterior: boolean;
  removedPixels: number;
  removedFraction: number;
  width: number;
  height: number;
}

export interface ChromaMaskResult {
  alpha: Uint8Array;
  width: number;
  height: number;
  stats: ChromaMaskStats;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

function normalizeHex(hex: string): string {
  const m = HEX_RE.exec(hex);
  if (!m) {
    throw new LocalOpError(
      "image.formatUnknown",
      `Invalid hex color: ${hex}. Expected #rrggbb.`,
    );
  }
  return `#${m[1]!.toLowerCase()}`;
}

/** Average border pixels (in linear-RGB) and convert back to sRGB hex. */
function detectBorderKey(
  rgba: Uint8Array,
  width: number,
  height: number,
  depth: number,
): string {
  const d = Math.max(1, Math.min(depth, Math.floor(Math.min(width, height) / 2)));
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  const sample = (x: number, y: number): void => {
    const i = (y * width + x) * 4;
    sumR += SRGB_TO_LINEAR_LUT[rgba[i]!]!;
    sumG += SRGB_TO_LINEAR_LUT[rgba[i + 1]!]!;
    sumB += SRGB_TO_LINEAR_LUT[rgba[i + 2]!]!;
    count++;
  };
  for (let y = 0; y < d && y < height; y++) for (let x = 0; x < width; x++) sample(x, y);
  for (let y = Math.max(d, height - d); y < height; y++) for (let x = 0; x < width; x++) sample(x, y);
  for (let y = d; y < Math.max(d, height - d); y++) {
    for (let x = 0; x < d && x < width; x++) sample(x, y);
    for (let x = Math.max(d, width - d); x < width; x++) sample(x, y);
  }
  const avgR = sumR / count;
  const avgG = sumG / count;
  const avgB = sumB / count;
  const linearToSRGB = (v: number): number => {
    if (v <= 0) return 0;
    if (v >= 1) return 255;
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255)));
  };
  const r = linearToSRGB(avgR);
  const g = linearToSRGB(avgG);
  const b = linearToSRGB(avgB);
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

async function resolveKey(
  rgba: Uint8Array,
  width: number,
  height: number,
  sourcePath: string | undefined,
  options: ChromaMaskOptions,
): Promise<{ hex: string; source: ChromaKeySource }> {
  const keyArg = options.key ?? CHROMA_DEFAULTS.key;
  if (keyArg === "auto") {
    const depth = options.borderSample ?? CHROMA_DEFAULTS.borderSample;
    return { hex: detectBorderKey(rgba, width, height, depth), source: "auto" };
  }
  if (keyArg === "from-sidecar") {
    if (!sourcePath) {
      throw new LocalOpError(
        "image.formatUnknown",
        "from-sidecar requires an input file path; pass it via chromaMaskFromFile().",
      );
    }
    return { hex: normalizeHex(await loadKeyFromSidecar(sourcePath)), source: "sidecar" };
  }
  return { hex: normalizeHex(keyArg), source: "explicit" };
}

/**
 * Force α=255 on any α≈0 pixel that is NOT connected to the image border via
 * other α≈0 pixels. The flood fill is 4-connected and uses a 128 threshold.
 */
function preserveInteriorRegions(
  alpha: Uint8Array,
  width: number,
  height: number,
): void {
  const n = width * height;
  const reachable = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qHead = 0;
  let qTail = 0;
  const enqueueBorder = (p: number): void => {
    if (alpha[p]! < 128 && reachable[p] === 0) {
      reachable[p] = 1;
      queue[qTail++] = p;
    }
  };
  for (let x = 0; x < width; x++) {
    enqueueBorder(x);
    enqueueBorder((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueueBorder(y * width);
    enqueueBorder(y * width + width - 1);
  }
  while (qHead < qTail) {
    const p = queue[qHead++]!;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) {
      const q = p - 1;
      if (reachable[q] === 0 && alpha[q]! < 128) {
        reachable[q] = 1;
        queue[qTail++] = q;
      }
    }
    if (x + 1 < width) {
      const q = p + 1;
      if (reachable[q] === 0 && alpha[q]! < 128) {
        reachable[q] = 1;
        queue[qTail++] = q;
      }
    }
    if (y > 0) {
      const q = p - width;
      if (reachable[q] === 0 && alpha[q]! < 128) {
        reachable[q] = 1;
        queue[qTail++] = q;
      }
    }
    if (y + 1 < height) {
      const q = p + width;
      if (reachable[q] === 0 && alpha[q]! < 128) {
        reachable[q] = 1;
        queue[qTail++] = q;
      }
    }
  }
  for (let p = 0; p < n; p++) {
    if (alpha[p]! < 128 && reachable[p] === 0) alpha[p] = 255;
  }
}

export interface ChromaMaskRunArgs extends ChromaMaskOptions {
  in: string;
}

export async function chromaMaskFromFile(
  args: ChromaMaskRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<ChromaMaskResult> {
  const { signal } = opts;
  throwIfAborted(signal);
  const { data, width, height } = await loadRawRGBA(args.in);
  throwIfAborted(signal);
  return chromaMask(data, width, height, args, args.in, signal);
}

/**
 * Compute a chroma alpha mask. `rgba` is RGBA8 of size width*height*4.
 * `sourcePath` is required only if `options.key === "from-sidecar"`.
 */
export async function chromaMask(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: ChromaMaskOptions,
  sourcePath?: string,
  signal?: AbortSignal,
): Promise<ChromaMaskResult> {
  throwIfAborted(signal);
  const preserveInterior = options.preserveInterior ?? CHROMA_DEFAULTS.preserveInterior;
  const { hex, source } = await resolveKey(rgba, width, height, sourcePath, options);

  const linear = parseHex(hex).map((v) => SRGB_TO_LINEAR_LUT[v]!) as [
    number,
    number,
    number,
  ];
  const topology: KeyTopology = analyzeKey(linear);

  const n = width * height;
  let alpha: Uint8Array;
  if (topology === null) {
    // Achromatic / multi-channel key: spill formula does not apply. Leave the
    // image fully opaque so the user can still composite it as-is.
    alpha = new Uint8Array(n).fill(255);
  } else {
    const { linR, linG, linB } = linearizeRGBA(rgba);
    throwIfAborted(signal);
    const sat = options.saturationRatio ?? CHROMA_DEFAULTS.saturationRatio;
    alpha = spillAlpha(linR, linG, linB, topology, sat);
    if (preserveInterior) {
      throwIfAborted(signal);
      preserveInteriorRegions(alpha, width, height);
    }
  }

  let removedPixels = 0;
  for (let p = 0; p < n; p++) {
    if (alpha[p]! < 128) removedPixels++;
  }
  const removedFraction = n > 0 ? removedPixels / n : 0;

  return {
    alpha,
    width,
    height,
    stats: {
      method: "chroma",
      key: hex,
      keySource: source,
      preserveInterior,
      removedPixels,
      removedFraction,
      width,
      height,
    },
  };
}
