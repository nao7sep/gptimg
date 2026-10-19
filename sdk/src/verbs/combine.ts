import { verbDone, verbStart } from "../events/index.ts";
import type { RefusedResult } from "../refusal.ts";
import type { SdkContext } from "../context.ts";
import {
  assertSingleFileAvailable,
  pngEncodingEventFields,
  pngEncodingOf,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.ts";
import { runCombine } from "../local/combine.ts";
import type { CombineArgs, CombineResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateCombineArgs } from "./schemas.ts";

export type CombineContext = SdkContext;

function defaultStem(firstInput: string, op: string): string {
  return `${inferStem(firstInput)}-${op}`;
}

export async function combineImpl(
  ctx: CombineContext,
  args: CombineArgs,
  opts: VerbCallOptions = {},
): Promise<CombineResult | RefusedResult> {
  validateCombineArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "combine", opts, async (logger) => {
    const firstInput = args.inputs[0]!;
    const outPath = await resolveOutputPath(args, {
      inputForDir: firstInput,
      stem: defaultStem(firstInput, args.op),
      ext: "png",
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    logger.emit("info", "resolve", verbStart({
      op: args.op,
      inputs: args.inputs,
      out: outPath,
      radius: args.radius ?? null,
      ...pngEncodingEventFields(args),
    }));

    const result = await runCombine(
      {
        op: args.op,
        inputs: args.inputs,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...pngEncodingOf(args),
        radius: args.radius,
      },
      { signal, logger },
    );
    logger.emit("info", "write", verbDone({
      path: result.output,
      width: result.width,
      height: result.height,
    }));

    return {
      inputs: args.inputs,
      output: result.output,
      width: result.width,
      height: result.height,
      op: result.op,
      status: "completed" as const,
    };
  });
}
