/**
 * BiRefNet inference wrapper. Lazy: the ONNX session is created the first
 * time the wrapper is called and reused thereafter for the lifetime of the
 * process.
 *
 * Pipeline:
 *   1. RGBA input at any size.
 *   2. Drop alpha, resize to `inputSize × inputSize` (bilinear), normalize
 *      with ImageNet mean/std, transpose to NCHW float32.
 *   3. Single forward pass.
 *   4. Take the final-stage sigmoid alpha output, resize back to the source
 *      dimensions, quantize to Uint8Array.
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { LocalOpError } from "../../errors.js";
import { ensureModel } from "./fetch.js";
import { BIREFNET } from "./registry.js";

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

let cachedSession: ort.InferenceSession | null = null;
let cachedSessionPath: string | null = null;

async function loadSession(modelPath: string): Promise<ort.InferenceSession> {
  if (cachedSession && cachedSessionPath === modelPath) return cachedSession;
  try {
    cachedSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    });
    cachedSessionPath = modelPath;
    return cachedSession;
  } catch (err) {
    throw new LocalOpError(
      "model.loadFailed",
      `Failed to load BiRefNet ONNX session: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

async function resizeRGB(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Promise<Uint8Array> {
  const rgb = await sharp(Buffer.from(rgba), {
    raw: { width: srcW, height: srcH, channels: 4 },
  })
    .removeAlpha()
    .resize(dstW, dstH, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  return new Uint8Array(rgb);
}

async function resizeAlphaUp(
  alpha: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Promise<Uint8Array> {
  // sharp may widen single-channel raw input to 3 channels during resampling.
  // Force single-channel output via `.toColourspace("b-w")` so the returned
  // buffer has exactly dstW*dstH bytes.
  const out = await sharp(Buffer.from(alpha), {
    raw: { width: srcW, height: srcH, channels: 1 },
  })
    .resize(dstW, dstH, { fit: "fill", kernel: "lanczos3" })
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  return new Uint8Array(out);
}

function preprocessToTensor(rgb: Uint8Array, size: number): ort.Tensor {
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
  return new ort.Tensor("float32", data, [1, 3, size, size]);
}

function tensorToAlpha(tensor: ort.Tensor, size: number): Uint8Array {
  // BiRefNet's ONNX export emits raw logits at [1, 1, H, W]. We apply sigmoid
  // to map them into [0, 1] and quantize to a Uint8Array mask.
  const data = tensor.data as Float32Array;
  const out = new Uint8Array(size * size);
  const offset = data.length - size * size;
  for (let p = 0; p < size * size; p++) {
    const v = data[offset + p]!;
    const sig = 1 / (1 + Math.exp(-v));
    out[p] = Math.max(0, Math.min(255, Math.round(sig * 255)));
  }
  return out;
}

export interface AiMaskResult {
  alpha: Uint8Array;
  width: number;
  height: number;
}

export async function runBirefnet(
  rgba: Uint8Array,
  width: number,
  height: number,
  cacheDir: string,
  signal: AbortSignal | undefined,
): Promise<AiMaskResult> {
  const modelPath = await ensureModel(BIREFNET, cacheDir, { signal });
  const session = await loadSession(modelPath);

  const size = BIREFNET.inputSize;
  const rgb = await resizeRGB(rgba, width, height, size, size);
  const tensor = preprocessToTensor(rgb, size);

  const inputName = session.inputNames[0];
  if (!inputName) {
    throw new LocalOpError(
      "model.loadFailed",
      "BiRefNet ONNX session has no input. Model file may be malformed.",
    );
  }
  const outputs = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[session.outputNames.length - 1]!;
  const output = outputs[outputName];
  if (!output) {
    throw new LocalOpError(
      "model.loadFailed",
      `BiRefNet ONNX session produced no output named ${outputName}.`,
    );
  }

  const alphaAtModel = tensorToAlpha(output, size);
  const alpha = await resizeAlphaUp(alphaAtModel, size, size, width, height);
  return { alpha, width, height };
}
