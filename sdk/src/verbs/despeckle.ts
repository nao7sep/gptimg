import { verbDone, verbStart } from "../events/index.ts";
import type { RefusedResult } from "../refusal.ts";
import type { SdkContext } from "../context.ts";
import {
  assertSingleFileAvailable,
  encodingEventFields,
  encodingOf,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.ts";
import { runDespeckle } from "../local/despeckle.ts";
import type { DespeckleArgs, DespeckleResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateDespeckleArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";

export type DespeckleContext = SdkContext;

function defaultStem(input: string): string {
  return `${inferStem(input)}-despeckle`;
}

export async function despeckleImpl(
  ctx: DespeckleContext,
  args: DespeckleArgs,
  opts: VerbCallOptions = {},
): Promise<DespeckleResult | RefusedResult> {
  validateDespeckleArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "despeckle", opts, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: extensionFor(args.format ?? "png"),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    logger.emit("info", "resolve", verbStart({
      input: args.in,
      out: outPath,
      threshold: args.threshold ?? null,
      minArea: args.minArea ?? null,
      connectivity: args.connectivity ?? null,
      keep: args.keep ?? null,
      ...encodingEventFields(args),
    }));

    const result = await runDespeckle(
      {
        in: args.in,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        threshold: args.threshold,
        minArea: args.minArea,
        connectivity: args.connectivity,
        keep: args.keep,
      },
      { signal },
    );

    logger.emit("info", "write", verbDone({
      path: result.output,
      flooredPixels: result.flooredPixels,
      components: result.components,
      removedComponents: result.removedComponents,
      removedPixels: result.removedPixels,
      bboxBefore: result.bboxBefore,
      bboxAfter: result.bboxAfter,
    }));

    return {
      input: args.in,
      output: result.output,
      threshold: result.threshold,
      minArea: result.minArea,
      connectivity: result.connectivity,
      keep: result.keep,
      flooredPixels: result.flooredPixels,
      components: result.components,
      removedComponents: result.removedComponents,
      removedPixels: result.removedPixels,
      bboxBefore: result.bboxBefore,
      bboxAfter: result.bboxAfter,
      width: result.width,
      height: result.height,
      status: "completed" as const,
    };
  });
}
