/**
 * Pure tensor encode/decode for Swin2SR — the per-tile numeric work around the
 * ONNX call, lifted out of the session I/O for unit testing. The tiling and
 * pad/crop geometry already lives, model-free, in `swin2sr.ts` (`planTiles` /
 * `tileAndStitch` with an injected runner); this is the per-tensor packing.
 */

import { LocalOpError } from "../../errors.js";

/** Interleaved-RGB u8 (`w × h`) → planar NCHW float32 rescaled to [0,1] (no mean
 *  subtraction — the Swin2SR processor contract). Layout `[R…][G…][B…]`. */
export function packNchw01(rgb: Uint8Array, w: number, h: number): Float32Array {
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    out[p] = rgb[i]! / 255;
    out[n + p] = rgb[i + 1]! / 255;
    out[2 * n + p] = rgb[i + 2]! / 255;
  }
  return out;
}

/**
 * Planar CHW float32 reconstruction (expected `[1, 3, oh, ow]`, values in ~[0,1])
 * → interleaved-RGB u8, clamped to [0,255]. The shape is validated so a malformed
 * export fails loudly instead of producing garbage.
 */
export function unpackChwToU8(
  data: Float32Array,
  dims: readonly number[],
  ow: number,
  oh: number,
): Uint8Array {
  if (dims.length !== 4 || dims[0] !== 1 || dims[1] !== 3 || Number(dims[2]) !== oh || Number(dims[3]) !== ow) {
    throw new LocalOpError(
      "model.outputShape",
      `Swin2SR output shape unexpected: got [${dims.join(",")}], expected [1,3,${oh},${ow}].`,
    );
  }
  const plane = ow * oh;
  const res = new Uint8Array(plane * 3);
  for (let q = 0, d = 0; q < plane; q++, d += 3) {
    for (let c = 0; c < 3; c++) {
      const v = data[c * plane + q]!;
      res[d + c] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
  }
  return res;
}
