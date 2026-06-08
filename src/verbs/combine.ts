import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runCombine } from "../local/combine.js";
import type { CombineArgs, CombineResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateCombineArgs } from "./schemas.js";

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
  validateCombineArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "combine", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
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
