import { LocalOpError } from "../../errors.js";
import type { ChromaKeySource } from "../../types.js";
import { fitGaussian, isotropicGaussian, srgbToLab } from "./backgroundModel.js";
import type { GaussianModel } from "./backgroundModel.js";

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

export interface KeyResolution {
  /** Resolved hex string, "#rrggbb". */
  hex: string;
  source: ChromaKeySource;
  model: GaussianModel;
  /**
   * For "auto": the indices of pixels used to fit the model.
   * For explicit/sidecar: empty (model is synthetic).
   */
  sampleIndices: Int32Array;
}

function parseHex(hex: string): [number, number, number] {
  const m = HEX_RE.exec(hex);
  if (!m) {
    throw new LocalOpError(
      "image.formatUnknown",
      `Invalid hex color: ${hex}. Expected #rrggbb.`,
    );
  }
  const h = m[1]!;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const t = (n: number) => n.toString(16).padStart(2, "0");
  return `#${t(r)}${t(g)}${t(b)}`;
}

export function sampleBorderIndices(
  width: number,
  height: number,
  depth: number,
): Int32Array {
  const d = Math.max(1, Math.min(depth, Math.floor(Math.min(width, height) / 2)));
  const indices: number[] = [];
  for (let y = 0; y < d && y < height; y++) {
    for (let x = 0; x < width; x++) indices.push(y * width + x);
  }
  for (let y = Math.max(d, height - d); y < height; y++) {
    for (let x = 0; x < width; x++) indices.push(y * width + x);
  }
  const innerYStart = d;
  const innerYEnd = Math.max(d, height - d);
  for (let y = innerYStart; y < innerYEnd; y++) {
    for (let x = 0; x < d && x < width; x++) indices.push(y * width + x);
    for (let x = Math.max(d, width - d); x < width; x++) indices.push(y * width + x);
  }
  return Int32Array.from(indices);
}

export function resolveAutoKey(
  rgba: Uint8Array,
  width: number,
  height: number,
  lab: Float32Array,
  borderDepth: number,
): KeyResolution {
  const idx = sampleBorderIndices(width, height, borderDepth);
  const model = fitGaussian(lab, idx);
  // Convert mean LAB back to a representative RGB hex by sampling the closest
  // border pixel by LAB distance to the mean.
  const [mL, mA, mB] = model.mean;
  let bestI = idx[0]!;
  let bestD = Infinity;
  for (let k = 0; k < idx.length; k++) {
    const p = idx[k]! * 3;
    const dL = lab[p]! - mL;
    const dA = lab[p + 1]! - mA;
    const dB = lab[p + 2]! - mB;
    const d2 = dL * dL + dA * dA + dB * dB;
    if (d2 < bestD) {
      bestD = d2;
      bestI = idx[k]!;
    }
  }
  const r = rgba[bestI * 4]!;
  const g = rgba[bestI * 4 + 1]!;
  const b = rgba[bestI * 4 + 2]!;
  return {
    hex: rgbToHex(r, g, b),
    source: "auto",
    model,
    sampleIndices: idx,
  };
}

export function resolveExplicitKey(hex: string, source: ChromaKeySource): KeyResolution {
  const [r, g, b] = parseHex(hex);
  const lab = srgbToLab(r, g, b);
  // Use a moderate isotropic variance in LAB². 4 → std ≈ 2 in LAB units.
  const model = isotropicGaussian(lab, 4);
  return {
    hex: rgbToHex(r, g, b),
    source,
    model,
    sampleIndices: new Int32Array(0),
  };
}
