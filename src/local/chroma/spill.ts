/**
 * Pure spill math shared between the chroma mask producer and the compose
 * verb's optional decontamination pass. No I/O.
 *
 * Spill in linear-light RGB:
 *   primary key   (R, G, or B dominant): spill = max(0, C[key] − max(C[other_1], C[other_2]))
 *   secondary key (one channel suppressed): spill = max(0, min(C[other_1], C[other_2]) − C[suppressed])
 *   α = clamp(1 − spill / key_strength, 0, 1)
 *
 * A pure-key pixel has spill = key_strength so α = 0. A pixel with no key
 * contamination has spill = 0 so α = 1. Everything in between is proportional.
 */

export const SRGB_TO_LINEAR_LUT = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

export function linearToSRGBByte(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 1) return 255;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

export function parseHex(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export type KeyTopology =
  | { kind: "primary"; channel: 0 | 1 | 2; strength: number }
  | { kind: "secondary"; suppressed: 0 | 1 | 2; strength: number }
  | null;

/**
 * Classify a key color as primary (one dominant channel — R/G/B), secondary
 * (one suppressed channel — C/M/Y), or neither. Achromatic or very dark keys
 * return null; callers should leave such images untouched.
 */
export function analyzeKey(linear: [number, number, number]): KeyTopology {
  const [a, b, c] = linear;
  const max = Math.max(a, b, c);
  const min = Math.min(a, b, c);
  const mid = a + b + c - max - min;
  if (max < 0.05) return null;
  let maxIdx: 0 | 1 | 2 = 0;
  let minIdx: 0 | 1 | 2 = 0;
  for (const i of [1, 2] as const) {
    if (linear[i] > linear[maxIdx]) maxIdx = i;
    if (linear[i] < linear[minIdx]) minIdx = i;
  }
  const primaryGap = max - mid;
  const secondaryGap = mid - min;
  if (primaryGap >= secondaryGap && primaryGap >= 0.05) {
    return { kind: "primary", channel: maxIdx, strength: max };
  }
  if (secondaryGap > primaryGap && secondaryGap >= 0.05) {
    return { kind: "secondary", suppressed: minIdx, strength: mid - min };
  }
  return null;
}

export function linearizeRGBA(rgba: Uint8Array): {
  linR: Float32Array;
  linG: Float32Array;
  linB: Float32Array;
} {
  const n = rgba.length / 4;
  const linR = new Float32Array(n);
  const linG = new Float32Array(n);
  const linB = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    linR[p] = SRGB_TO_LINEAR_LUT[rgba[i]!]!;
    linG[p] = SRGB_TO_LINEAR_LUT[rgba[i + 1]!]!;
    linB[p] = SRGB_TO_LINEAR_LUT[rgba[i + 2]!]!;
  }
  return { linR, linG, linB };
}

/**
 * Compute per-pixel alpha from spill against a given key topology. Returns a
 * Uint8Array of length width*height with values 0..255.
 */
export function spillAlpha(
  linR: Float32Array,
  linG: Float32Array,
  linB: Float32Array,
  topology: NonNullable<KeyTopology>,
): Uint8Array {
  const n = linR.length;
  const channels = [linR, linG, linB] as const;
  const pivot = topology.kind === "primary" ? topology.channel : topology.suppressed;
  const linPivot = channels[pivot];
  const linOtherA = channels[((pivot + 1) % 3) as 0 | 1 | 2];
  const linOtherB = channels[((pivot + 2) % 3) as 0 | 1 | 2];
  const strength = topology.strength;
  const isPrimary = topology.kind === "primary";
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const a = linOtherA[p]!;
    const b = linOtherB[p]!;
    const spill = isPrimary
      ? linPivot[p]! - (a > b ? a : b)
      : (a < b ? a : b) - linPivot[p]!;
    if (spill <= 0) {
      out[p] = 255;
    } else {
      const ratio = spill / strength;
      if (ratio >= 1) out[p] = 0;
      else out[p] = Math.round((1 - ratio) * 255);
    }
  }
  return out;
}
