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

import os from "node:os";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { LocalOpError } from "../../errors.js";
import type { Logger } from "../../log/index.js";
import type { NetworkBudget } from "../../network/defaults.js";
import { ensureModel } from "./fetch.js";
import { BIREFNET } from "./registry.js";

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

const ONNX_THREADS_ENV = "GPTIMG_ONNX_INTRA_OP_THREADS";
const ONNX_EP_ENV = "GPTIMG_ONNX_EP";

let cachedSession: ort.InferenceSession | null = null;
let cachedSessionPath: string | null = null;

/**
 * Cap the intra-op thread pool per session. ONNX Runtime's CPU EP defaults
 * to one thread per core, which is fine for a single inference but pathological
 * when the same machine runs multiple gptimg processes — each session grabs
 * all cores and they thrash the scheduler. Halving the core count per session
 * keeps a single call fast while letting parallel callers coexist without
 * total oversubscription. A single core minimum keeps tiny VMs working.
 * `GPTIMG_ONNX_INTRA_OP_THREADS` overrides the count for explicit tuning.
 */
function intraOpThreadCount(): number {
  const override = process.env[ONNX_THREADS_ENV];
  if (override !== undefined && override.length > 0) {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 1) {
      throw new LocalOpError(
        "model.loadFailed",
        `${ONNX_THREADS_ENV} must be a positive integer; got "${override}".`,
      );
    }
    return n;
  }
  const cpus = os.cpus()?.length ?? 1;
  return Math.max(1, Math.floor(cpus / 2));
}

/**
 * Execution providers for the ONNX session. Defaults to CPU (the only EP
 * guaranteed present in onnxruntime-node). `GPTIMG_ONNX_EP` takes a
 * comma-separated, priority-ordered list (e.g. `coreml,cpu`) for users whose
 * build ships an accelerated EP; an unavailable EP fails loudly at session
 * creation.
 */
function executionProviders(): string[] {
  const override = process.env[ONNX_EP_ENV];
  if (override === undefined) return ["cpu"];
  const eps = override
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return eps.length > 0 ? eps : ["cpu"];
}

async function loadSession(modelPath: string): Promise<ort.InferenceSession> {
  if (cachedSession && cachedSessionPath === modelPath) return cachedSession;
  try {
    cachedSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: executionProviders(),
      intraOpNumThreads: intraOpThreadCount(),
      interOpNumThreads: 1,
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

/**
 * Convert the model's logit output tensor to a Uint8 alpha mask. The pinned
 * BiRefNet export emits `[1, 1, H, W]` raw logits; we validate that shape
 * explicitly and read H/W from `dims` rather than assuming inputSize, so
 * future variants that downsample (e.g. deep-supervision outputs at H/4)
 * fail loudly with a clear error instead of silently reading wrong data.
 */
function tensorToAlpha(tensor: ort.Tensor): { alpha: Uint8Array; width: number; height: number } {
  const dims = tensor.dims;
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
  const data = tensor.data as Float32Array;
  const expected = width * height;
  if (data.length !== expected) {
    throw new LocalOpError(
      "model.outputShape",
      `BiRefNet output tensor has ${data.length} elements; expected ${expected} for [1,1,${height},${width}].`,
    );
  }
  const out = new Uint8Array(expected);
  for (let p = 0; p < expected; p++) {
    const v = data[p]!;
    const sig = 1 / (1 + Math.exp(-v));
    out[p] = Math.max(0, Math.min(255, Math.round(sig * 255)));
  }
  return { alpha: out, width, height };
}

export interface BirefnetOutput {
  alpha: Uint8Array;
  width: number;
  height: number;
}

export async function runBirefnet(
  rgba: Uint8Array,
  width: number,
  height: number,
  cacheDir: string,
  opts: {
    signal?: AbortSignal | undefined;
    budget?: NetworkBudget;
    logger?: Logger;
  } = {},
): Promise<BirefnetOutput> {
  const modelPath = await ensureModel(BIREFNET, cacheDir, opts);
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

  const { alpha: alphaAtModel, width: outW, height: outH } = tensorToAlpha(output);
  const alpha = await resizeAlphaUp(alphaAtModel, outW, outH, width, height);
  return { alpha, width, height };
}
