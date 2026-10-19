import { verbDone, verbStart } from "../events/index.ts";
import type { RefusedResult } from "../refusal.ts";
import { callModelsDir, callPolicy, type SdkContext } from "../context.ts";
import {
  assertSingleFileAvailable,
  encodingEventFields,
  encodingOf,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.ts";
import { runUpscale } from "../local/upscale.ts";
import { validateOnnxSection } from "../policy/schemas.ts";
import type { UpscaleArgs, UpscaleResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateUpscaleArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";

export type UpscaleContext = SdkContext;

function defaultStem(input: string): string {
  return `${inferStem(input)}-upscale`;
}

export async function upscaleImpl(
  ctx: UpscaleContext,
  args: UpscaleArgs,
  opts: VerbCallOptions = {},
): Promise<UpscaleResult | RefusedResult> {
  validateUpscaleArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "upscale", opts, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: extensionFor(args.format ?? "png"),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    const onnx = validateOnnxSection(callPolicy(ctx, args.policy).onnx);
    const modelsDir = callModelsDir(ctx, args.modelsDir);

    logger.emit("info", "resolve", verbStart({
      input: args.in,
      out: outPath,
      toSize: args.toSize ?? null,
      kernel: args.kernel ?? null,
      tile: args.tile ?? null,
      ...encodingEventFields(args),
    }));

    const result = await runUpscale(
      {
        in: args.in,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        toSize: args.toSize,
        kernel: args.kernel,
        tile: args.tile,
      },
      modelsDir,
      { signal, onnx, logger },
    );

    logger.emit("info", "write", verbDone({
      path: result.output,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      modelWidth: result.modelWidth,
      modelHeight: result.modelHeight,
      width: result.width,
      height: result.height,
      tiles: result.tiles,
    }));

    return {
      input: args.in,
      output: result.output,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      modelWidth: result.modelWidth,
      modelHeight: result.modelHeight,
      width: result.width,
      height: result.height,
      toSize: result.toSize,
      kernel: result.kernel,
      tile: result.tile,
      tiles: result.tiles,
      status: "completed" as const,
    };
  });
}
