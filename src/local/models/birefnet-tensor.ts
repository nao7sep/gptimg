/**
 * Pure tensor pre/post-processing for BiRefNet — the numeric work that surrounds
 * the ONNX call, lifted out of the session I/O so it is unit-testable without the
 * runtime or model weights. `birefnet.ts` wraps these in an `ort.Tensor` on the
 * way in and reads the output tensor's data/dims on the way out; the math lives
 * here.
 */

import { LocalOpError } from "../../errors.js";

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * Interleaved-RGB u8 (`size × size`) → planar NCHW float32, rescaled to [0,1] and
 * ImageNet-normalized per channel. Output layout is `[R…][G…][B…]`, each plane
 * `size·size` long.
 */
export function normalizeImageNet(rgb: Uint8Array, size: number): Float32Array {
  const n = size * size;
  const data = new Float32Array(3 * n);
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    const r = rgb[i]! / 255;
    const g = rgb[i + 1]! / 255;
    const b = rgb[i + 2]! / 255;
    data[p] = (r - IMAGENET_MEAN[0]!) / IMAGENET_STD[0]!;
    data[n + p] = (g - IMAGENET_MEAN[1]!) / IMAGENET_STD[1]!;
    data[2 * n + p] = (b - IMAGENET_MEAN[2]!) / IMAGENET_STD[2]!;
  }
  return data;
}

/**
 * Final-stage logits (expected `[1, 1, H, W]`) → Uint8 alpha via sigmoid. The
 * shape is validated explicitly and H/W are read from `dims` rather than assumed,
 * so a variant that downsamples (e.g. a deep-supervision output at H/4) fails
 * loudly instead of silently reading wrong data.
 */
export function logitsToAlpha(
  data: Float32Array,
  dims: readonly number[],
): { alpha: Uint8Array; width: number; height: number } {
  if (dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1) {
    throw new LocalOpError(
      "model.outputShape",
      `BiRefNet output shape unexpected: got [${dims.join(",")}], expected [1, 1, H, W].`,
    );
  }
  const height = Number(dims[2]);
  const width = Number(dims[3]);
  if (!Number.isFinite(height) || !Number.isFinite(width) || height <= 0 || width <= 0) {
    throw new LocalOpError(
      "model.outputShape",
      `BiRefNet output spatial dims invalid: H=${dims[2]}, W=${dims[3]}.`,
    );
  }
  const expected = width * height;
  if (data.length !== expected) {
    throw new LocalOpError(
      "model.outputShape",
      `BiRefNet output tensor has ${data.length} elements; expected ${expected} for [1,1,${height},${width}].`,
    );
  }
  const alpha = new Uint8Array(expected);
  for (let p = 0; p < expected; p++) {
    const sig = 1 / (1 + Math.exp(-data[p]!));
    alpha[p] = Math.max(0, Math.min(255, Math.round(sig * 255)));
  }
  return { alpha, width, height };
}
