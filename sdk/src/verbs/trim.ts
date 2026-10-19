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
import { runTrim } from "../local/trim.ts";
import type { TrimArgs, TrimResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateTrimArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";

export type TrimContext = SdkContext;

function defaultStem(input: string): string {
  return `${inferStem(input)}-trim`;
}

export async function trimImpl(
  ctx: TrimContext,
  args: TrimArgs,
  opts: VerbCallOptions = {},
): Promise<TrimResult | RefusedResult> {
  validateTrimArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "trim", opts, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: extensionFor(args.format ?? "png"),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    logger.emit("info", "resolve", verbStart({
      input: args.in,
      out: outPath,
      margin: args.margin ?? null,
      square: args.square ?? false,
      ...encodingEventFields(args),
    }));

    const result = await runTrim(
      {
        in: args.in,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        margin: args.margin,
        square: args.square,
      },
      { signal },
    );

    logger.emit("info", "write", verbDone({
      path: result.output,
      width: result.width,
      height: result.height,
      bbox: result.bbox,
      marginPx: result.marginPx,
    }));

    return {
      input: args.in,
      output: result.output,
      bbox: result.bbox,
      margin: result.margin,
      marginPx: result.marginPx,
      width: result.width,
      height: result.height,
      square: result.square,
      status: "completed" as const,
    };
  });
}
