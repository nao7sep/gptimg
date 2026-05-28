/**
 * AI mask producer. Mirrors the shape of `chromaMaskFromFile` so the verb
 * layer can dispatch on `method` without caring about the producer details.
 */

import { toAbortError } from "../errors.js";
import { loadRawRGBA } from "../image/bridge.js";
import { runBirefnet } from "./models/birefnet.js";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

export interface AiMaskRunArgs {
  in: string;
}

export interface AiMaskStats {
  method: "ai";
  model: "birefnet";
  removedPixels: number;
  removedFraction: number;
  width: number;
  height: number;
}

export interface AiMaskResult {
  alpha: Uint8Array;
  width: number;
  height: number;
  stats: AiMaskStats;
}

export async function aiMaskFromFile(
  args: AiMaskRunArgs,
  cacheDir: string,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<AiMaskResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const image = await loadRawRGBA(args.in);
  throwIfAborted(signal);

  const result = await runBirefnet(
    image.data,
    image.width,
    image.height,
    cacheDir,
    signal,
  );

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
    },
  };
}
