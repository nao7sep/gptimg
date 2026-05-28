/**
 * Spill-based alpha matting for chroma-key removal.
 *
 * For each pixel we compute the spill — how much the key channel exceeds the
 * other two channels — in linear-light RGB. α follows directly:
 *
 *   spill = max(0, C[key] − max(C[other_1], C[other_2]))
 *   α     = 1 − spill / key_strength
 *
 * A pure-key pixel has spill = key_strength so α = 0 (fully transparent),
 * regardless of where it sits in the image. A pixel with no key contamination
 * has spill = 0 so α = 1. Everything in between is proportional. No
 * thresholds, no smoothstep, no region scoring affects α.
 *
 * For the foreground color F we sample from confirmed-opaque pixels. The
 * spill-tainted color in a partial-α pixel carries almost no usable
 * information about the true subject color (most of what the camera saw was
 * the background showing through), so we propagate F outward from α = 1
 * pixels by iterated 4-connected dilation. The composite over a new
 * background renders as the real subject color fading toward transparent,
 * never as a dark Vlahos clip and never as a green halo.
 *
 * When `preserveInterior` is set, any pixel not in the `accepted` mask
 * (meaning: not part of a region the detector classified as background) is
 * forced to α = 1. That keeps interior key-colored regions intact — donut
 * holes, the green segments of a rainbow stamp, a green tie that didn't get
 * border-connected — at the cost of not auto-deleting interior pure-key
 * content. The default is false: interior key regions become transparent, so
 * tiny gaps between hair strands disappear cleanly.
 */

const SRGB_TO_LINEAR_LUT = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

function linearToSRGBByte(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 1) return 255;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export interface MattingOptions {
  /**
   * When true, force α = 1 for pixels outside the detector's accepted mask.
   * Keeps interior key-colored regions (donut holes, intentional green
   * subject content) opaque instead of letting per-pixel spill make them
   * transparent. Defaults to false.
   */
  preserveInterior: boolean;
}

export const MATTING_DEFAULTS: MattingOptions = {
  preserveInterior: false,
};

export interface MattingResult {
  /** Output RGBA buffer, sRGB-encoded with α already in channel 3. */
  rgba: Uint8Array;
  /** Per-pixel α (0..255). Identical to the alpha channel in rgba. */
  alpha: Uint8Array;
}

/**
 * Identify which RGB channel is the key's dominant chromaticity. Returns
 * null for achromatic or multi-channel keys, in which case the matting
 * algorithm bails out and leaves every pixel opaque.
 */
function determineKeyChannel(B: [number, number, number]): 0 | 1 | 2 | null {
  const max = Math.max(B[0], B[1], B[2]);
  if (max < 0.05) return null;
  const sorted = [...B].sort((a, b) => b - a);
  if (sorted[0]! - sorted[1]! < 0.05) return null;
  if (B[0] === max) return 0;
  if (B[1] === max) return 1;
  return 2;
}

export function solveMatting(
  rgba: Uint8Array,
  width: number,
  height: number,
  accepted: Uint8Array,
  keyHex: string,
  opts: Partial<MattingOptions> = {},
): MattingResult {
  const o: MattingOptions = { ...MATTING_DEFAULTS, ...opts };
  const n = width * height;

  // Linearize input once.
  const linR = new Float32Array(n);
  const linG = new Float32Array(n);
  const linB = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    linR[p] = SRGB_TO_LINEAR_LUT[rgba[i]!]!;
    linG[p] = SRGB_TO_LINEAR_LUT[rgba[i + 1]!]!;
    linB[p] = SRGB_TO_LINEAR_LUT[rgba[i + 2]!]!;
  }

  const [kR, kG, kB] = parseHex(keyHex);
  const Bk: [number, number, number] = [
    SRGB_TO_LINEAR_LUT[kR]!,
    SRGB_TO_LINEAR_LUT[kG]!,
    SRGB_TO_LINEAR_LUT[kB]!,
  ];
  const keyChannel = determineKeyChannel(Bk);

  // Fall back: if the key isn't a clean single-channel dominant, the spill
  // formula doesn't apply. Return the original image untouched.
  if (keyChannel === null) {
    const outRgba = new Uint8Array(n * 4);
    const outAlpha = new Uint8Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      outRgba[i] = rgba[i]!;
      outRgba[i + 1] = rgba[i + 1]!;
      outRgba[i + 2] = rgba[i + 2]!;
      outRgba[i + 3] = 255;
      outAlpha[p] = 255;
    }
    return { rgba: outRgba, alpha: outAlpha };
  }

  const keyStrength = Bk[keyChannel];
  const linChannels: [Float32Array, Float32Array, Float32Array] = [linR, linG, linB];
  const linKey = linChannels[keyChannel]!;
  const linOtherA = linChannels[(keyChannel + 1) % 3]!;
  const linOtherB = linChannels[(keyChannel + 2) % 3]!;

  // Per-pixel α from spill.
  const alphaF = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const other = linOtherA[p]! > linOtherB[p]! ? linOtherA[p]! : linOtherB[p]!;
    const spill = linKey[p]! - other;
    if (spill <= 0) {
      alphaF[p] = 1;
    } else {
      const ratio = spill / keyStrength;
      alphaF[p] = ratio >= 1 ? 0 : 1 - ratio;
    }
  }

  // Interior preservation: any pixel not in the accepted background mask is
  // forced opaque. This keeps interior key-colored regions intact.
  if (o.preserveInterior) {
    for (let p = 0; p < n; p++) {
      if (accepted[p]! === 0) alphaF[p] = 1;
    }
  }

  // Inpaint F. Pixels at α = 1 are trusted sources of true subject color.
  // For every other pixel, we propagate color outward by iterated 4-connected
  // dilation, averaging contributions from already-filled neighbors. This
  // halts naturally when every reachable pixel has been filled.
  const srcR = new Float32Array(n);
  const srcG = new Float32Array(n);
  const srcB = new Float32Array(n);
  const filled = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (alphaF[p]! >= 1) {
      srcR[p] = linR[p]!;
      srcG[p] = linG[p]!;
      srcB[p] = linB[p]!;
      filled[p] = 1;
    }
  }

  // Double-buffered dilation: read from `src`, write to `dst`, then swap.
  let curR = srcR;
  let curG = srcG;
  let curB = srcB;
  let curFilled = filled;
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
        if (x > 0) {
          const q = p - 1;
          if (curFilled[q]! !== 0) {
            sumR += curR[q]!;
            sumG += curG[q]!;
            sumB += curB[q]!;
            count++;
          }
        }
        if (x + 1 < width) {
          const q = p + 1;
          if (curFilled[q]! !== 0) {
            sumR += curR[q]!;
            sumG += curG[q]!;
            sumB += curB[q]!;
            count++;
          }
        }
        if (y > 0) {
          const q = p - width;
          if (curFilled[q]! !== 0) {
            sumR += curR[q]!;
            sumG += curG[q]!;
            sumB += curB[q]!;
            count++;
          }
        }
        if (y + 1 < height) {
          const q = p + width;
          if (curFilled[q]! !== 0) {
            sumR += curR[q]!;
            sumG += curG[q]!;
            sumB += curB[q]!;
            count++;
          }
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
    const tmpR = curR;
    const tmpG = curG;
    const tmpB = curB;
    const tmpFilled = curFilled;
    curR = nextR;
    curG = nextG;
    curB = nextB;
    curFilled = nextFilled;
    nextR = tmpR;
    nextG = tmpG;
    nextB = tmpB;
    nextFilled = tmpFilled;
  }

  // Compose. For pixels that were never reached by inpainting (only happens
  // when the entire image is partial-α with no opaque source), keep the
  // observed color as a last-resort fallback.
  const outRgba = new Uint8Array(n * 4);
  const outAlpha = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = alphaF[p]!;
    const aByte = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
    if (aByte === 0) {
      outAlpha[p] = 0;
      continue;
    }
    const r = curFilled[p]! !== 0 ? curR[p]! : linR[p]!;
    const g = curFilled[p]! !== 0 ? curG[p]! : linG[p]!;
    const b = curFilled[p]! !== 0 ? curB[p]! : linB[p]!;
    outRgba[i] = linearToSRGBByte(r);
    outRgba[i + 1] = linearToSRGBByte(g);
    outRgba[i + 2] = linearToSRGBByte(b);
    outRgba[i + 3] = aByte;
    outAlpha[p] = aByte;
  }

  return { rgba: outRgba, alpha: outAlpha };
}
