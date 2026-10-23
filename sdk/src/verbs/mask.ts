import { verbDone, verbStart } from "../events/index.ts";
import type { RefusedResult } from "../refusal.ts";
import { callModelsDir, callPolicy, type SdkContext } from "../context.ts";
import { GptImgError, throwIfAborted } from "../errors.ts";
import { writeMaskPNG } from "../image/bridge.ts";
import {
  assertSingleFileAvailable,
  inferStem,
  pngEncodingEventFields,
  pngEncodingOf,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.ts";
import { aiMaskFromFile } from "../local/ai-mask.ts";
import { chromaMaskFromFile } from "../local/chroma/mask.ts";
import type {
  MaskArgs,
  MaskResult,
  MaskStats,
} from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { applyChromaPolicyDefaults } from "./mask-defaults.ts";
import { validateMaskArgs } from "./schemas.ts";

export type MaskContext = SdkContext;

function defaultStem(input: string): string {
  return `${inferStem(input)}-mask`;
}

export async function maskImpl(
  ctx: MaskContext,
  args: MaskArgs,
  opts: VerbCallOptions = {},
): Promise<MaskResult | RefusedResult> {
  validateMaskArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "mask", opts, async (logger) => {
    const method = args.method ?? "chroma";
    const policy = callPolicy(ctx, args.policy);

    // Resolve and check the output before doing any masking work — including,
    // for method "ai", an inference run — so a rerun without `overwrite` over
    // an existing output is refused at once instead of after the compute, as
    // every other local verb (e.g. upscale) already does.
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: "png",
    });
    await assertSingleFileAvailable(outPath, args.overwrite ?? false);

    let alpha: Uint8Array;
    let width: number;
    let height: number;
    let stats: MaskStats;

    if (method === "chroma") {
      const chromaSection = policy.chroma ?? {};
      const resolved = applyChromaPolicyDefaults(args, chromaSection);

      logger.emit("info", "resolve", verbStart({
        input: resolved.in,
        method,
        key: resolved.key ?? "auto",
        preserveInterior: resolved.preserveInterior ?? false,
        ...pngEncodingEventFields(args),
      }));

      const result = await chromaMaskFromFile(
        {
          in: resolved.in,
          key: resolved.key,
          preserveInterior: resolved.preserveInterior,
          borderSample: resolved.borderSample,
          saturationRatio: resolved.saturationRatio,
        },
        { signal },
      );
      alpha = result.alpha;
      width = result.width;
      height = result.height;
      stats = result.stats;
    } else if (method === "ai") {
      const onnx = policy.onnx ?? {};
      logger.emit("info", "resolve", verbStart({
        input: args.in,
        method,
        ...pngEncodingEventFields(args),
      }));

      const result = await aiMaskFromFile(
        { in: args.in },
        callModelsDir(ctx, args.modelsDir),
        { signal, onnx, logger },
      );
      alpha = result.alpha;
      width = result.width;
      height = result.height;
      stats = result.stats;
    } else {
      throw new GptImgError("args.invalid", `mask method "${method}" is not implemented.`, {
        details: { field: "method", constraint: "chroma or ai" },
      });
    }

    throwIfAborted(signal);

    await writeMaskPNG(alpha, width, height, { path: outPath, overwrite: args.overwrite ?? false, signal, source: args.in }, pngEncodingOf(args));
    logger.emit("info", "write", verbDone({ path: outPath, stats }));

    return {
      input: args.in,
      output: outPath,
      stats,
      status: "completed" as const,
    };
  });
}
