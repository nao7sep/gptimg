import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runDespeckle } from "../local/despeckle.js";
import type { DespeckleArgs, DespeckleResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateDespeckleArgs } from "./schemas.js";

export interface DespeckleContext {
  profileDir: string;
  logDir: string;
}

function defaultStem(input: string): string {
  return `${inferStem(input)}-despeckle`;
}

export async function despeckleImpl(
  ctx: DespeckleContext,
  args: DespeckleArgs,
  opts: VerbCallOptions = {},
): Promise<DespeckleResult> {
  validateDespeckleArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "despeckle", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const dryRun = args.dryRun ?? false;

    await logger.info("resolve", "despeckle start", {
      input: args.in,
      threshold: args.threshold ?? null,
      minArea: args.minArea ?? null,
      connectivity: args.connectivity ?? null,
      keep: args.keep ?? null,
      dryRun,
    });

    // Mirror mask: resolve/assert the output only on the real (writing) path.
    let outPath: string | undefined;
    if (!dryRun) {
      outPath = await resolveOutputPath(args, {
        inputForDir: args.in,
        stem: defaultStem(args.in),
        ext: "png",
      });
      assertSingleFileAvailable(outPath, args.overwrite ?? false);
    }

    const result = await runDespeckle(
      {
        in: args.in,
        out: outPath,
        threshold: args.threshold,
        minArea: args.minArea,
        connectivity: args.connectivity,
        keep: args.keep,
        dryRun,
      },
      { signal },
    );

    await logger.info(
      dryRun ? "stats" : "write",
      dryRun ? "despeckle complete (dry run)" : "wrote despeckled image",
      {
        path: result.output,
        flooredPixels: result.flooredPixels,
        components: result.components,
        removedComponents: result.removedComponents,
        removedPixels: result.removedPixels,
        bboxBefore: result.bboxBefore,
        bboxAfter: result.bboxAfter,
      },
    );

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
      logPath: logger.handle.path,
    };
  });
}
