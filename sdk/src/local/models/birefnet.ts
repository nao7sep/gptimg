/**
 * BiRefNet inference wrapper. Lazy: the ONNX session is created the first
 * time the wrapper is called and reused until model.release retires the cache.
 *
 * Pipeline:
 *   1. RGBA input at any size.
 *   2. Drop alpha, resize to `inputSize × inputSize` (bilinear), normalize
 *      with ImageNet mean/std, transpose to NCHW float32.
 *   3. Single forward pass.
 *   4. Take the final-stage sigmoid alpha output, resize back to the source
 *      dimensions, quantize to Uint8Array.
 */

import type * as Ort from "onnxruntime-node";
import sharp from "../../image/sharp.ts";
import { GptImgError, throwIfAborted } from "../../errors.ts";
import { resizeSingleChannel } from "../../image/bridge.ts";
import type { Logger } from "../../events/index.ts";
import { requireInstalledModel } from "./fetch.ts";
import type { OnnxPolicy } from "../../types.ts";
import { BIREFNET } from "./registry.ts";
import { float32Tensor, withSession, runSession } from "./session.ts";
import { logitsToAlpha, normalizeImageNet } from "./birefnet-tensor.ts";

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
    .resize(dstW, dstH, { fit: "fill", kernel: "linear" })
    .raw()
    .toBuffer();
  return new Uint8Array(rgb);
}

function preprocessToTensor(rgb: Uint8Array, size: number): Promise<Ort.Tensor> {
  return float32Tensor(normalizeImageNet(rgb, size), [1, 3, size, size]);
}

/**
 * Convert the model's logit output tensor to a Uint8 alpha mask. The pinned
 * BiRefNet export emits `[1, 1, H, W]` raw logits; we validate that shape
 * explicitly and read H/W from `dims` rather than assuming inputSize, so
 * spatially downsampled outputs are supported and resized to the source
 * dimensions; incompatible shapes or data lengths fail explicitly.
 */
function tensorToAlpha(tensor: Ort.Tensor): { alpha: Uint8Array; width: number; height: number } {
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
  modelsDir: string,
  opts: {
    signal?: AbortSignal | undefined;
    onnx?: OnnxPolicy | undefined;
    logger?: Logger;
  } = {},
): Promise<BirefnetOutput> {
  const modelPath = requireInstalledModel(BIREFNET, "birefnet", modelsDir);
  // Session creation and inference block the thread and cannot be interrupted
  // (onnxruntime-node runs them synchronously), so cancellation is honored at
  // the boundaries around them.
  throwIfAborted(opts.signal);
  return withSession(modelPath, opts.onnx, async (session) => {
    throwIfAborted(opts.signal);

    const size = BIREFNET.inputSize;
    const rgb = await resizeRGB(rgba, width, height, size, size);
    const tensor = await preprocessToTensor(rgb, size);

    const inputName = session.inputNames[0];
    if (!inputName) {
      throw new GptImgError(
        "model.loadFailed",
        "BiRefNet ONNX session has no input. Model file may be malformed.",
      );
    }
    opts.logger?.emit("info", "infer", { event: "model.infer.start", model: "birefnet", settings: { width, height } });
    throwIfAborted(opts.signal);
    const outputs = await runSession(session, { [inputName]: tensor });
    opts.logger?.emit("info", "infer", { event: "model.infer.done", model: "birefnet", stats: {} });
    throwIfAborted(opts.signal);
    const outputName = session.outputNames[session.outputNames.length - 1]!;
    const output = outputs[outputName];
    if (!output) {
      throw new GptImgError(
        "model.loadFailed",
        `BiRefNet ONNX session produced no output named ${outputName}.`,
      );
    }

    const { alpha: alphaAtModel, width: outW, height: outH } = tensorToAlpha(output);
    const alpha = await resizeSingleChannel(alphaAtModel, outW, outH, width, height);
    throwIfAborted(opts.signal);
    return { alpha, width, height };
  });
}
