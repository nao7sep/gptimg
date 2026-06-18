/**
 * Keycheck: a deterministic, read-only measurement of how much chroma-key colour
 * survives in a keyed cutout — the "did background removal succeed?" check the
 * icon/stamp workflows describe (an edge-ring hue scan) but never had as code.
 *
 * It transforms nothing. It scans every shipping pixel (alpha > 0) and decides,
 * by a principled HSV rule, whether the pixel is biased toward the *key* hue:
 *
 *   residue ⇔ saturation ≥ minSaturation        (gate out near-gray pixels, whose
 *                                                 hue is numerically unstable)
 *           ∧ value      ≥ minValue              (gate out near-black pixels)
 *           ∧ hueDistance(pixel, key) ≤ hueTolerance
 *
 * The gates are why a legitimately key-*adjacent* subject colour is not flagged:
 * a moderately-saturated colour a few tens of degrees off the key hue fails the
 * hue gate, and a near-gray pixel fails the saturation gate. Leftover key, by
 * contrast, is both highly saturated and within a few degrees of the pure key.
 *
 * Residue is split by location: a residue pixel on the alpha edge (it has a
 * fully-transparent in-bounds 4-neighbour) is *fringe*; a residue pixel in the
 * interior is a *missed background patch*. The edge fraction is the fringe metric;
 * any interior residue means the keyer left whole background behind.
 *
 * Only the key colour is needed; the verb resolves "from-sidecar"/explicit before
 * calling here, so this module receives a concrete "#rrggbb".
 */

import { LocalOpError, toAbortError } from "../errors.js";
import { loadRawRGBA, writeRGBA } from "../image/bridge.js";
import { parseHex } from "../color.js";
import type { AlphaBBox } from "../types.js";

export const KEYCHECK_DEFAULTS = {
  hueTolerance: 20,
  minSaturation: 0.35,
  minValue: 0.25,
  maxEdgeResidueFraction: 0.02,
  maxInteriorResiduePixels: 0,
} as const;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

/**
 * RGB (0..255) → HSV. Hue in [0, 360) or NaN for an achromatic pixel (delta 0);
 * saturation and value in [0, 1]. Standard conversion; the first-match max
 * branch is correct for the primary/secondary key colours (e.g. magenta and
 * cyan resolve identically whichever of their two equal-max channels is picked).
 */
export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h: number;
  if (d === 0) {
    h = NaN;
  } else if (max === rn) {
    h = 60 * ((gn - bn) / d);
  } else if (max === gn) {
    h = 60 * (2 + (bn - rn) / d);
  } else {
    h = 60 * (4 + (rn - gn) / d);
  }
  if (h < 0) h += 360;
  else if (h >= 360) h -= 360;
  return { h, s, v };
}

/** Smallest absolute angular distance between two hues in degrees, in [0, 180]. */
export function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export interface KeycheckRunArgs {
  in: string;
  /** Already-resolved key colour, "#rrggbb". */
  key: string;
  hueTolerance?: number;
  minSaturation?: number;
  minValue?: number;
  maxEdgeResidueFraction?: number;
  maxInteriorResiduePixels?: number;
  /** When set, write a debug heatmap to this path. */
  heatmapOut?: string | undefined;
}

export interface KeycheckRunResult {
  width: number;
  height: number;
  presentPixels: number;
  edgePixels: number;
  residuePixels: number;
  edgeResiduePixels: number;
  interiorResiduePixels: number;
  edgeResidueFraction: number;
  residueFraction: number;
  worstBBox: AlphaBBox | null;
  hueTolerance: number;
  minSaturation: number;
  minValue: number;
  verdict: "clean" | "residue";
  heatmapPath: string | null;
}

export async function runKeycheck(
  args: KeycheckRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<KeycheckRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const hueTolerance = args.hueTolerance ?? KEYCHECK_DEFAULTS.hueTolerance;
  const minSaturation = args.minSaturation ?? KEYCHECK_DEFAULTS.minSaturation;
  const minValue = args.minValue ?? KEYCHECK_DEFAULTS.minValue;
  const maxEdgeResidueFraction =
    args.maxEdgeResidueFraction ?? KEYCHECK_DEFAULTS.maxEdgeResidueFraction;
  const maxInteriorResiduePixels =
    args.maxInteriorResiduePixels ?? KEYCHECK_DEFAULTS.maxInteriorResiduePixels;

  const [kr, kg, kb] = parseHex(args.key);
  const keyHsv = rgbToHsv(kr, kg, kb);
  if (!Number.isFinite(keyHsv.h)) {
    // An achromatic "key" (gray/black/white) has no hue to scan toward; this is a
    // misuse, not a measurement we can fudge.
    throw new LocalOpError(
      "args.invalid",
      `keycheck: key ${args.key} is achromatic (no hue); a chroma key must be a saturated colour.`,
    );
  }
  const keyHue = keyHsv.h;

  const { data, width, height } = await loadRawRGBA(args.in);
  throwIfAborted(signal);
  const n = width * height;

  // Pass 1 — classify each pixel: present (ships) and residue (key-biased).
  const present = new Uint8Array(n);
  const residue = new Uint8Array(n);
  let presentPixels = 0;
  let residuePixels = 0;
  for (let p = 0; p < n; p++) {
    const a = data[p * 4 + 3]!;
    if (a === 0) continue;
    present[p] = 1;
    presentPixels++;
    const { h, s, v } = rgbToHsv(data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!);
    if (
      Number.isFinite(h) &&
      s >= minSaturation &&
      v >= minValue &&
      hueDistance(h, keyHue) <= hueTolerance
    ) {
      residue[p] = 1;
      residuePixels++;
    }
  }

  // Pass 2 — edge classification and tallies. A present pixel is an edge pixel
  // when an in-bounds 4-neighbour is absent (alpha 0). The image border is NOT an
  // edge: a subject touching the canvas without a transparent margin has no alpha
  // boundary there, and counting the border would invent fringe.
  let edgePixels = 0;
  let edgeResiduePixels = 0;
  let bx0 = width;
  let by0 = height;
  let bx1 = -1;
  let by1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (present[p] === 0) continue;
      const onEdge =
        (x > 0 && present[p - 1] === 0) ||
        (x < width - 1 && present[p + 1] === 0) ||
        (y > 0 && present[p - width] === 0) ||
        (y < height - 1 && present[p + width] === 0);
      if (onEdge) edgePixels++;
      if (residue[p] === 1) {
        if (onEdge) edgeResiduePixels++;
        if (x < bx0) bx0 = x;
        if (y < by0) by0 = y;
        if (x > bx1) bx1 = x;
        if (y > by1) by1 = y;
      }
    }
  }

  const interiorResiduePixels = residuePixels - edgeResiduePixels;
  const edgeResidueFraction = edgePixels > 0 ? edgeResiduePixels / edgePixels : 0;
  const residueFraction = presentPixels > 0 ? residuePixels / presentPixels : 0;
  const worstBBox: AlphaBBox | null =
    bx1 < 0 ? null : { x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1 };
  const verdict: "clean" | "residue" =
    edgeResidueFraction <= maxEdgeResidueFraction &&
    interiorResiduePixels <= maxInteriorResiduePixels
      ? "clean"
      : "residue";

  let heatmapPath: string | null = null;
  if (args.heatmapOut) {
    // Edge residue → red, interior residue → orange, other shipping pixels →
    // faint gray, background → transparent. A glance shows where (and which kind
    // of) residue is.
    const out = new Uint8Array(n * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (present[p] === 0) continue;
        const o = p * 4;
        if (residue[p] === 1) {
          const onEdge =
            (x > 0 && present[p - 1] === 0) ||
            (x < width - 1 && present[p + 1] === 0) ||
            (y > 0 && present[p - width] === 0) ||
            (y < height - 1 && present[p + width] === 0);
          out[o] = 255;
          out[o + 1] = onEdge ? 0 : 128;
          out[o + 2] = 0;
          out[o + 3] = 255;
        } else {
          out[o] = 90;
          out[o + 1] = 90;
          out[o + 2] = 90;
          out[o + 3] = 110;
        }
      }
    }
    throwIfAborted(signal);
    await writeRGBA(out, width, height, args.heatmapOut);
    heatmapPath = args.heatmapOut;
  }

  return {
    width,
    height,
    presentPixels,
    edgePixels,
    residuePixels,
    edgeResiduePixels,
    interiorResiduePixels,
    edgeResidueFraction,
    residueFraction,
    worstBBox,
    hueTolerance,
    minSaturation,
    minValue,
    verdict,
    heatmapPath,
  };
}
