import { dilate, erode, xorMasks } from "./morphology.js";

export interface EdgeBandOpts {
  dilate: number;
  erode: number;
}

/**
 * Compute a thin band along the boundary of `accepted` where soft alpha
 * is computed. Outside the band, alpha snaps to fully opaque or fully
 * transparent based on `accepted`.
 *
 * band = dilate(accepted, k) XOR erode(accepted, k)
 */
export function computeEdgeBand(
  accepted: Uint8Array,
  width: number,
  height: number,
  opts: EdgeBandOpts,
): Uint8Array {
  const dilated = dilate(accepted, width, height, Math.max(0, opts.dilate));
  const eroded = erode(accepted, width, height, Math.max(0, opts.erode));
  return xorMasks(dilated, eroded);
}
