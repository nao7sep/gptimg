import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runResize } from "../local/resize.js";
import type { ResizeArgs, ResizeResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateResizeArgs } from "./schemas.js";

export interface ResizeContext {
  profileDir: string;
  logDir: string;
}

function defaultOutputName(input: string): string {
  return `${inferStem(input)}-resize.png`;
}

export async function resizeImpl(
  ctx: ResizeContext,
  args: ResizeArgs,
  opts: VerbCallOptions = {},
): Promise<ResizeResult> {
  validateResizeArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "resize", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      outName: defaultOutputName(args.in),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "resize start", {
      input: args.in,
      out: outPath,
      toSize: args.toSize,
      kernel: args.kernel ?? null,
    });

    const result = await runResize(
      { in: args.in, out: outPath, toSize: args.toSize, kernel: args.kernel },
      { signal },
    );

    await logger.info("write", "wrote resized image", {
      path: result.output,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      width: result.width,
      height: result.height,
    });

    return {
      input: args.in,
      output: result.output,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      width: result.width,
      height: result.height,
      toSize: result.toSize,
      kernel: result.kernel,
      logPath: logger.handle.path,
    };
  });
}
