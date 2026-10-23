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
import { runResize } from "../local/resize.ts";
import type { ResizeArgs, ResizeResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateResizeArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";
import { ENCODING_DEFAULTS } from "../defaults.ts";

export type ResizeContext = SdkContext;

function defaultStem(input: string): string {
  return `${inferStem(input)}-resize`;
}

export async function resizeImpl(
  ctx: ResizeContext,
  args: ResizeArgs,
  opts: VerbCallOptions = {},
): Promise<ResizeResult | RefusedResult> {
  validateResizeArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "resize", opts, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: extensionFor(args.format ?? ENCODING_DEFAULTS.format),
    });
    await assertSingleFileAvailable(outPath, args.overwrite ?? false);

    logger.emit("info", "resolve", verbStart({
      input: args.in,
      out: outPath,
      toSize: args.toSize,
      kernel: args.kernel ?? null,
      ...encodingEventFields(args),
    }));

    const result = await runResize(
      {
        in: args.in,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        toSize: args.toSize,
        kernel: args.kernel,
      },
      { signal },
    );

    logger.emit("info", "write", verbDone({
      path: result.output,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      width: result.width,
      height: result.height,
    }));

    return {
      input: args.in,
      output: result.output,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      width: result.width,
      height: result.height,
      toSize: result.toSize,
      kernel: result.kernel,
      status: "completed" as const,
    };
  });
}
