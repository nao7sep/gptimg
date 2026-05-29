import { LocalOpError } from "../errors.js";
import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runCombine } from "../local/combine.js";
import type { CombineArgs, CombineResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";

export interface CombineContext {
  profileDir: string;
  logDir: string;
}

function defaultOutputName(firstInput: string, op: string): string {
  return `${inferStem(firstInput)}-${op}.png`;
}

export async function combineImpl(
  ctx: CombineContext,
  args: CombineArgs,
  opts: VerbCallOptions = {},
): Promise<CombineResult> {
  const signal = opts.signal;

  return withVerbLogger(ctx, "combine", args.log, async (logger) => {
    if (!args.inputs.length) {
      throw new LocalOpError(
        "args.invalid",
        `combine ${args.op} requires at least one input.`,
      );
    }
    const firstInput = args.inputs[0]!;
    const outPath = await resolveOutputPath(args, {
      inputForDir: firstInput,
      outName: defaultOutputName(firstInput, args.op),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "combine start", {
      op: args.op,
      inputs: args.inputs,
      out: outPath,
      radius: args.radius ?? null,
    });

    const result = await runCombine(
      { op: args.op, inputs: args.inputs, out: outPath, radius: args.radius },
      { signal },
    );
    await logger.info("write", "wrote combined mask", {
      path: result.output,
      width: result.width,
      height: result.height,
    });

    return {
      inputs: args.inputs,
      output: result.output,
      width: result.width,
      height: result.height,
      op: result.op,
      logPath: logger.handle.path,
    };
  });
}
