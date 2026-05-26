/**
 * Color space + background distribution math for the chroma pipeline.
 *
 * - sRGB → LAB via D65 reference white, with a 256-entry LUT for gamma decode.
 * - Single multivariate Gaussian fit (mean + covariance + inverse covariance).
 * - Per-pixel Mahalanobis distance evaluation.
 * - Closed-form 3x3 symmetric eigenvalue computation for diagnostics.
 */

const GAMMA_LUT = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

const D65_X = 0.95047;
const D65_Y = 1.0;
const D65_Z = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

function fLab(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = GAMMA_LUT[r]!;
  const lg = GAMMA_LUT[g]!;
  const lb = GAMMA_LUT[b]!;

  const X = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / D65_X;
  const Y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175) / D65_Y;
  const Z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / D65_Z;

  const fx = fLab(X);
  const fy = fLab(Y);
  const fz = fLab(Z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function rgbaBufferToLab(
  rgba: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const lab = srgbToLab(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    out[j] = lab[0];
    out[j + 1] = lab[1];
    out[j + 2] = lab[2];
  }
  return out;
}

export interface GaussianModel {
  mean: [number, number, number];
  cov: [number, number, number, number, number, number]; // s11, s12, s13, s22, s23, s33
  inv: [number, number, number, number, number, number]; // i11, i12, i13, i22, i23, i33
  /** Sorted descending. */
  eigenvalues: [number, number, number];
  /** Number of samples used to fit. */
  sampleCount: number;
}

const REG_LAMBDA = 1e-3;

function invert3x3Sym(
  s11: number,
  s12: number,
  s13: number,
  s22: number,
  s23: number,
  s33: number,
): [number, number, number, number, number, number] {
  let a11 = s11 + REG_LAMBDA;
  let a22 = s22 + REG_LAMBDA;
  let a33 = s33 + REG_LAMBDA;
  let a12 = s12;
  let a13 = s13;
  let a23 = s23;

  let det =
    a11 * (a22 * a33 - a23 * a23) -
    a12 * (a12 * a33 - a23 * a13) +
    a13 * (a12 * a23 - a22 * a13);

  if (Math.abs(det) < 1e-12) {
    // Heavy regularization fallback.
    a11 += 1;
    a22 += 1;
    a33 += 1;
    det =
      a11 * (a22 * a33 - a23 * a23) -
      a12 * (a12 * a33 - a23 * a13) +
      a13 * (a12 * a23 - a22 * a13);
  }
  const inv = 1 / det;
  return [
    (a22 * a33 - a23 * a23) * inv,
    -(a12 * a33 - a23 * a13) * inv,
    (a12 * a23 - a22 * a13) * inv,
    (a11 * a33 - a13 * a13) * inv,
    -(a11 * a23 - a12 * a13) * inv,
    (a11 * a22 - a12 * a12) * inv,
  ];
}

function eigenvalues3x3Sym(
  s11: number,
  s12: number,
  s13: number,
  s22: number,
  s23: number,
  s33: number,
): [number, number, number] {
  const p1 = s12 * s12 + s13 * s13 + s23 * s23;
  if (p1 < 1e-15) {
    const arr: [number, number, number] = [s11, s22, s33];
    arr.sort((a, b) => b - a);
    return arr;
  }
  const q = (s11 + s22 + s33) / 3;
  const p2 = (s11 - q) ** 2 + (s22 - q) ** 2 + (s33 - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  // B = (1/p) * (A - q*I)
  const b11 = (s11 - q) / p;
  const b12 = s12 / p;
  const b13 = s13 / p;
  const b22 = (s22 - q) / p;
  const b23 = s23 / p;
  const b33 = (s33 - q) / p;
  const detB =
    b11 * (b22 * b33 - b23 * b23) -
    b12 * (b12 * b33 - b23 * b13) +
    b13 * (b12 * b23 - b22 * b13);
  let r = detB / 2;
  if (r < -1) r = -1;
  else if (r > 1) r = 1;
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  const arr: [number, number, number] = [e1, e2, e3];
  arr.sort((a, b) => b - a);
  return arr;
}

export function fitGaussian(
  lab: Float32Array,
  indices: number[] | Int32Array,
): GaussianModel {
  const n = indices.length;
  if (n === 0) {
    return {
      mean: [50, 0, 0],
      cov: [25, 0, 0, 25, 0, 25],
      inv: invert3x3Sym(25, 0, 0, 25, 0, 25),
      eigenvalues: [25, 25, 25],
      sampleCount: 0,
    };
  }
  let mL = 0;
  let mA = 0;
  let mB = 0;
  for (let k = 0; k < n; k++) {
    const j = indices[k]! * 3;
    mL += lab[j]!;
    mA += lab[j + 1]!;
    mB += lab[j + 2]!;
  }
  mL /= n;
  mA /= n;
  mB /= n;

  let s11 = 0;
  let s12 = 0;
  let s13 = 0;
  let s22 = 0;
  let s23 = 0;
  let s33 = 0;
  for (let k = 0; k < n; k++) {
    const j = indices[k]! * 3;
    const dL = lab[j]! - mL;
    const dA = lab[j + 1]! - mA;
    const dB = lab[j + 2]! - mB;
    s11 += dL * dL;
    s12 += dL * dA;
    s13 += dL * dB;
    s22 += dA * dA;
    s23 += dA * dB;
    s33 += dB * dB;
  }
  const denom = Math.max(1, n - 1);
  s11 /= denom;
  s12 /= denom;
  s13 /= denom;
  s22 /= denom;
  s23 /= denom;
  s33 /= denom;

  const inv = invert3x3Sym(s11, s12, s13, s22, s23, s33);
  const eigs = eigenvalues3x3Sym(s11, s12, s13, s22, s23, s33);
  return {
    mean: [mL, mA, mB],
    cov: [s11, s12, s13, s22, s23, s33],
    inv,
    eigenvalues: eigs,
    sampleCount: n,
  };
}

export function isotropicGaussian(
  mean: [number, number, number],
  variance = 4,
): GaussianModel {
  const inv = invert3x3Sym(variance, 0, 0, variance, 0, variance);
  return {
    mean,
    cov: [variance, 0, 0, variance, 0, variance],
    inv,
    eigenvalues: [variance, variance, variance],
    sampleCount: 0,
  };
}

export function distanceMap(lab: Float32Array, model: GaussianModel): Float32Array {
  const n = lab.length / 3;
  const out = new Float32Array(n);
  const [mL, mA, mB] = model.mean;
  const [i11, i12, i13, i22, i23, i33] = model.inv;
  for (let p = 0, j = 0; p < n; p++, j += 3) {
    const dL = lab[j]! - mL;
    const dA = lab[j + 1]! - mA;
    const dB = lab[j + 2]! - mB;
    const t1 = i11 * dL + i12 * dA + i13 * dB;
    const t2 = i12 * dL + i22 * dA + i23 * dB;
    const t3 = i13 * dL + i23 * dA + i33 * dB;
    const d2 = dL * t1 + dA * t2 + dB * t3;
    out[p] = Math.sqrt(d2 > 0 ? d2 : 0);
  }
  return out;
}
