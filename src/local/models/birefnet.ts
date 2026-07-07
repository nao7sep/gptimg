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
import { resizeSingleChannel } from "../../image/bridge.js";
import type { Logger } from "../../log/index.js";
import type { NetworkBudget } from "../../network/defaults.js";
import { ensureModel } from "./fetch.js";
import { BIREFNET } from "./registry.js";
import { loadSession } from "./session.js";
import { logitsToAlpha, normalizeImageNet } from "./birefnet-tensor.js";

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

function preprocessToTensor(rgb: Uint8Array, size: number): ort.Tensor {
  return new ort.Tensor("float32", normalizeImageNet(rgb, size), [1, 3, size, size]);
}

/**
 * Convert the model's logit output tensor to a Uint8 alpha mask. The pinned
 * BiRefNet export emits `[1, 1, H, W]` raw logits; we validate that shape
 * explicitly and read H/W from `dims` rather than assuming inputSize, so
 * future variants that downsample (e.g. deep-supervision outputs at H/4)
 * fail loudly with a clear error instead of silently reading wrong data.
 */
function tensorToAlpha(tensor: ort.Tensor): { alpha: Uint8Array; width: number; height: number } {
  return logitsToAlpha(tensor.data as Float32Array, tensor.dims);
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
  await opts.logger?.info("infer", "running BiRefNet inference", { width, height });
  const outputs = await session.run({ [inputName]: tensor });
  await opts.logger?.info("infer", "BiRefNet inference complete");
  const outputName = session.outputNames[session.outputNames.length - 1]!;
  const output = outputs[outputName];
  if (!output) {
    throw new LocalOpError(
      "model.loadFailed",
      `BiRefNet ONNX session produced no output named ${outputName}.`,
    );
  }

  const { alpha: alphaAtModel, width: outW, height: outH } = tensorToAlpha(output);
  const alpha = await resizeSingleChannel(alphaAtModel, outW, outH, width, height);
  return { alpha, width, height };
}
