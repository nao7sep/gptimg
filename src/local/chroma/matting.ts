/**
 * Closed-form per-pixel alpha matting for chroma-key removal.
 *
 * For each pixel C we solve C = α·F + (1-α)·B, where B is the known key color
 * and F is the unknown foreground color. The pipeline is:
 *
 * 1. Build a trimap from the binary `accepted` background mask:
 *      - definitely-background = erode(accepted, bgBand)
 *      - definitely-foreground = erode(~accepted, fgBand)
 *      - unknown                = everything else
 * 2. For each unknown pixel:
 *      - Sample several nearby definitely-foreground colors F_k (linear RGB).
 *      - For each candidate, project (C-B) onto (F_k-B) to get a clamped α_k.
 *      - Pick the (F_k, α_k) minimizing the composite residual.
 *      - Recover the decontaminated foreground F = (C - (1-α)B) / α.
 * 3. For definitely-foreground pixels, optionally apply continuous spill
 *    suppression on the key channel (Vlahos-style).
 *
 * All matting math runs in linear-light RGB; conversion to/from sRGB happens
 * only at the boundaries.
 */
import { erode } from "./morphology.js";

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
  /** Erosion of `accepted` to obtain definitely-background. */
  bgBand: number;
  /** Erosion of `~accepted` to obtain definitely-foreground. */
  fgBand: number;
  /** Max number of foreground candidates considered per unknown pixel. */
  candidateCount: number;
  /** Max pixel-distance search radius for foreground candidates. */
  searchRadius: number;
  /** When true, write decontaminated foreground colors; otherwise keep input RGB. */
  applyDecontamination: boolean;
}

export const MATTING_DEFAULTS: MattingOptions = {
  bgBand: 8,
  fgBand: 8,
  candidateCount: 6,
  searchRadius: 24,
  applyDecontamination: true,
};

export interface MattingResult {
  /** Output RGBA buffer, sRGB-encoded with α already in channel 3. */
  rgba: Uint8Array;
  /** Per-pixel α (0..255). Identical to the alpha channel in rgba. */
  alpha: Uint8Array;
}

/**
 * Detect which RGB channel carries the key's chromaticity. Returns null when
 * the key is achromatic or ambiguous (no channel clearly dominates).
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

/** Clamp the key channel of a linear-RGB color to the max of the other two. */
function suppressSpill(C: [number, number, number], keyChannel: 0 | 1 | 2): [number, number, number] {
  const i1 = (keyChannel + 1) % 3;
  const i2 = (keyChannel + 2) % 3;
  const other = Math.max(C[i1]!, C[i2]!);
  if (C[keyChannel] <= other) return C;
  const out: [number, number, number] = [C[0], C[1], C[2]];
  out[keyChannel] = other;
  return out;
}

/**
 * Walk outward in Chebyshev rings from (cx, cy), collecting indices of
 * `fgDef` pixels until `candidateCount` are found or `searchRadius` is reached.
 */
function findCandidates(
  fgDef: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  searchRadius: number,
  candidateCount: number,
  out: number[],
): void {
  out.length = 0;
  for (let r = 1; r <= searchRadius; r++) {
    const yTop = cy - r;
    const yBot = cy + r;
    const xLeft = cx - r;
    const xRight = cx + r;
    const xStart = Math.max(0, xLeft);
    const xEnd = Math.min(width - 1, xRight);
    if (yTop >= 0) {
      const row = yTop * width;
      for (let x = xStart; x <= xEnd; x++) {
        if (fgDef[row + x]! > 0) {
          out.push(row + x);
          if (out.length >= candidateCount) return;
        }
      }
    }
    if (yBot < height && yBot !== yTop) {
      const row = yBot * width;
      for (let x = xStart; x <= xEnd; x++) {
        if (fgDef[row + x]! > 0) {
          out.push(row + x);
          if (out.length >= candidateCount) return;
        }
      }
    }
    const yStart = Math.max(0, cy - r + 1);
    const yEnd = Math.min(height - 1, cy + r - 1);
    if (xLeft >= 0) {
      for (let y = yStart; y <= yEnd; y++) {
        const idx = y * width + xLeft;
        if (fgDef[idx]! > 0) {
          out.push(idx);
          if (out.length >= candidateCount) return;
        }
      }
    }
    if (xRight < width && xRight !== xLeft) {
      for (let y = yStart; y <= yEnd; y++) {
        const idx = y * width + xRight;
        if (fgDef[idx]! > 0) {
          out.push(idx);
          if (out.length >= candidateCount) return;
        }
      }
    }
  }
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
  const linear = new Float32Array(n * 3);
  for (let p = 0, i = 0, j = 0; p < n; p++, i += 4, j += 3) {
    linear[j] = SRGB_TO_LINEAR_LUT[rgba[i]!]!;
    linear[j + 1] = SRGB_TO_LINEAR_LUT[rgba[i + 1]!]!;
    linear[j + 2] = SRGB_TO_LINEAR_LUT[rgba[i + 2]!]!;
  }

  const [kR, kG, kB] = parseHex(keyHex);
  const Bk: [number, number, number] = [
    SRGB_TO_LINEAR_LUT[kR]!,
    SRGB_TO_LINEAR_LUT[kG]!,
    SRGB_TO_LINEAR_LUT[kB]!,
  ];
  const keyChannel = determineKeyChannel(Bk);

  // Trimap.
  const inverted = new Uint8Array(n);
  for (let p = 0; p < n; p++) inverted[p] = accepted[p]! === 0 ? 255 : 0;
  const bgDef = erode(accepted, width, height, Math.max(0, o.bgBand));
  const fgDef = erode(inverted, width, height, Math.max(0, o.fgBand));

  const outRgba = new Uint8Array(n * 4);
  const outAlpha = new Uint8Array(n);
  const candidates: number[] = [];

  for (let p = 0, i = 0, j = 0; p < n; p++, i += 4, j += 3) {
    if (bgDef[p]! > 0) {
      // Background-definite: fully transparent.
      outAlpha[p] = 0;
      // outRgba is already zero-initialized for r,g,b,a.
      continue;
    }

    const cR = linear[j]!;
    const cG = linear[j + 1]!;
    const cB = linear[j + 2]!;

    if (fgDef[p]! > 0) {
      // Foreground-definite: fully opaque with optional spill suppression.
      let fR = cR;
      let fG = cG;
      let fB = cB;
      if (o.applyDecontamination && keyChannel !== null) {
        const f = suppressSpill([cR, cG, cB], keyChannel);
        fR = f[0];
        fG = f[1];
        fB = f[2];
      }
      outRgba[i] = linearToSRGBByte(fR);
      outRgba[i + 1] = linearToSRGBByte(fG);
      outRgba[i + 2] = linearToSRGBByte(fB);
      outRgba[i + 3] = 255;
      outAlpha[p] = 255;
      continue;
    }

    // Unknown pixel: solve matting.
    const cx = p % width;
    const cy = (p - cx) / width;
    findCandidates(fgDef, width, height, cx, cy, o.searchRadius, o.candidateCount, candidates);

    let bestAlpha = -1;
    let bestResidual = Infinity;
    let bestFR = 0;
    let bestFG = 0;
    let bestFB = 0;

    const cMinusBR = cR - Bk[0];
    const cMinusBG = cG - Bk[1];
    const cMinusBB = cB - Bk[2];

    for (let k = 0; k < candidates.length; k++) {
      const cj = candidates[k]! * 3;
      const fR = linear[cj]!;
      const fG = linear[cj + 1]!;
      const fB = linear[cj + 2]!;
      const vR = fR - Bk[0];
      const vG = fG - Bk[1];
      const vB = fB - Bk[2];
      const vDot = vR * vR + vG * vG + vB * vB;
      if (vDot < 1e-6) continue;
      let aK = (cMinusBR * vR + cMinusBG * vG + cMinusBB * vB) / vDot;
      if (aK < 0) aK = 0;
      else if (aK > 1) aK = 1;
      const compR = aK * fR + (1 - aK) * Bk[0];
      const compG = aK * fG + (1 - aK) * Bk[1];
      const compB = aK * fB + (1 - aK) * Bk[2];
      const dR = cR - compR;
      const dG = cG - compG;
      const dB = cB - compB;
      const residual = dR * dR + dG * dG + dB * dB;
      if (residual < bestResidual) {
        bestResidual = residual;
        bestAlpha = aK;
        bestFR = fR;
        bestFG = fG;
        bestFB = fB;
      }
    }

    if (bestAlpha < 0) {
      // No usable candidates. Fall back to a key-chromaticity-based α so the
      // pixel is treated as foreground if its color is far from the key, and
      // gently faded otherwise. This keeps thin features from disappearing.
      if (keyChannel !== null) {
        const i1 = (keyChannel + 1) % 3;
        const i2 = (keyChannel + 2) % 3;
        const cArr: [number, number, number] = [cR, cG, cB];
        const otherMaxC = Math.max(cArr[i1]!, cArr[i2]!);
        const excess = Math.max(0, cArr[keyChannel] - otherMaxC);
        const keyExcess = Math.max(
          0,
          Bk[keyChannel] - Math.max(Bk[i1]!, Bk[i2]!),
        );
        const fade = keyExcess > 0 ? Math.min(1, excess / keyExcess) : 0;
        bestAlpha = 1 - fade;
      } else {
        bestAlpha = 1;
      }
      bestFR = cR;
      bestFG = cG;
      bestFB = cB;
    }

    let outFR: number;
    let outFG: number;
    let outFB: number;
    if (o.applyDecontamination && bestAlpha > 0.02) {
      // Recover the decontaminated foreground from the observation.
      const invA = 1 / bestAlpha;
      let rR = (cR - (1 - bestAlpha) * Bk[0]) * invA;
      let rG = (cG - (1 - bestAlpha) * Bk[1]) * invA;
      let rB = (cB - (1 - bestAlpha) * Bk[2]) * invA;
      if (rR < 0) rR = 0;
      else if (rR > 1) rR = 1;
      if (rG < 0) rG = 0;
      else if (rG > 1) rG = 1;
      if (rB < 0) rB = 0;
      else if (rB > 1) rB = 1;
      if (keyChannel !== null) {
        const f = suppressSpill([rR, rG, rB], keyChannel);
        outFR = f[0];
        outFG = f[1];
        outFB = f[2];
      } else {
        outFR = rR;
        outFG = rG;
        outFB = rB;
      }
    } else if (o.applyDecontamination) {
      // α too small to invert reliably: borrow the best sample's color so that
      // any residual visible pixel reads as nearby foreground, not as key.
      outFR = bestFR;
      outFG = bestFG;
      outFB = bestFB;
    } else {
      outFR = cR;
      outFG = cG;
      outFB = cB;
    }

    const aByte = Math.round(bestAlpha * 255);
    outRgba[i] = linearToSRGBByte(outFR);
    outRgba[i + 1] = linearToSRGBByte(outFG);
    outRgba[i + 2] = linearToSRGBByte(outFB);
    outRgba[i + 3] = aByte;
    outAlpha[p] = aByte;
  }

  return { rgba: outRgba, alpha: outAlpha };
}
