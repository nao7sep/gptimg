import { srgbToLab } from "./backgroundModel.js";

/**
 * For pixels with partial alpha (0 < α < 255), project the color away from
 * the key direction in LAB chroma space (a*, b*) by a factor proportional to
 * (1 - α/255). The L* channel is untouched. The amount of correction is
 * capped by the original color's chroma distance to the key.
 *
 * Operates in place on `rgba`.
 */
export function despill(
  rgba: Uint8Array,
  width: number,
  height: number,
  alpha: Uint8Array,
  keyHex: string,
  strength = 0.6,
): void {
  const [kr, kg, kb] = parseHex(keyHex);
  const keyLab = srgbToLab(kr, kg, kb);

  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const a = alpha[p]!;
    if (a === 0 || a === 255) continue;
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const lab = srgbToLab(r, g, b);
    const dA = lab[1] - keyLab[1];
    const dB = lab[2] - keyLab[2];
    const t = (1 - a / 255) * strength;
    // Move chroma away from key by factor t along the (key → pixel) direction
    // in (a*, b*) chroma space.
    const newA = lab[1] + dA * t;
    const newB = lab[2] + dB * t;
    const [nr, ng, nb] = labToSrgb(lab[0], newA, newB);
    rgba[i] = nr;
    rgba[i + 1] = ng;
    rgba[i + 2] = nb;
  }
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const D65_X = 0.95047;
const D65_Y = 1.0;
const D65_Z = 1.08883;

function fLabInv(t: number): number {
  const t3 = t * t * t;
  return t3 > 216 / 24389 ? t3 : (116 * t - 16) / (24389 / 27);
}

function clamp255(v: number): number {
  v = v * 255;
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

function gammaEncode(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function labToSrgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const X = fLabInv(fx) * D65_X;
  const Y = fLabInv(fy) * D65_Y;
  const Z = fLabInv(fz) * D65_Z;
  const lr = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const lg = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const lb = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [
    clamp255(gammaEncode(lr)),
    clamp255(gammaEncode(lg)),
    clamp255(gammaEncode(lb)),
  ];
}
