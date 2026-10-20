/**
 * AI mask producer. Mirrors the shape of `chromaMaskFromFile` so the verb
 * layer can dispatch on `method` without caring about the producer details.
 */

import type { AiMaskStats, OnnxPolicy } from "../types.ts";
import { throwIfAborted } from "../errors.ts";
import { loadRawRGBA } from "../image/bridge.ts";
import type { Logger } from "../events/index.ts";
import { runBirefnet } from "./models/birefnet.ts";
import { BIREFNET } from "./models/registry.ts";
import { inferenceRecord } from "./models/session.ts";

export interface AiMaskRunArgs {
  in: string;
}

export interface AiMaskResult {
  alpha: Uint8Array;
  width: number;
  height: number;
  stats: AiMaskStats;
}

export async function aiMaskFromFile(
  args: AiMaskRunArgs,
  modelsDir: string,
  opts: {
    signal?: AbortSignal | undefined;
    onnx?: OnnxPolicy | undefined;
    logger?: Logger;
  } = {},
): Promise<AiMaskResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const image = await loadRawRGBA(args.in);
  throwIfAborted(signal);

  const result = await runBirefnet(image.data, image.width, image.height, modelsDir, opts);

  let removedPixels = 0;
  const n = result.width * result.height;
  for (let p = 0; p < n; p++) {
    if (result.alpha[p]! < 128) removedPixels++;
  }
  const removedFraction = n > 0 ? removedPixels / n : 0;

  return {
    alpha: result.alpha,
    width: result.width,
    height: result.height,
    stats: {
      method: "ai",
      model: "birefnet",
      removedPixels,
      removedFraction,
      width: result.width,
      height: result.height,
      inference: await inferenceRecord({ key: "birefnet", ...BIREFNET }, opts.onnx),
    },
  };
}
