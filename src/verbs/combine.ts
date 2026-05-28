import path from "node:path";
import { existsSync } from "node:fs";
import { LocalOpError } from "../errors.js";
import { ensureOutputDir } from "../internal/output-files.js";
import { createLogger, safeLogError } from "../log/index.js";
import { runCombine } from "../local/combine.js";
import type { CombineArgs, CombineResult } from "../types.js";
import { defaultLogPath, utcTimestamp } from "../internal/paths.js";
import type { VerbCallOptions } from "./options.js";

export interface CombineContext {
  profileDir: string;
  logDir: string;
}

function inferStem(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function defaultOutputName(firstInput: string, op: string): string {
  return `${inferStem(firstInput)}-${op}.png`;
}

function checkOverwrite(filePath: string, allowOverwrite: boolean): void {
  if (!allowOverwrite && existsSync(filePath)) {
    throw new LocalOpError(
      "output.exists",
      `Output exists: ${filePath}. Use --overwrite to allow.`,
    );
  }
}

export async function combineImpl(
  ctx: CombineContext,
  args: CombineArgs,
  opts: VerbCallOptions = {},
): Promise<CombineResult> {
  const ts = utcTimestamp();
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const logger = await createLogger(logPath, "combine");
  const signal = opts.signal;

  try {
    if (!args.inputs.length) {
      throw new LocalOpError(
        "image.formatUnknown",
        `combine ${args.op} requires at least one input.`,
      );
    }
    const firstInput = args.inputs[0]!;
    const inDir = path.dirname(firstInput);
    const outDir = args.outDir ?? inDir;
    await ensureOutputDir(outDir);
    const outName = args.outName ?? defaultOutputName(firstInput, args.op);
    const outPath = path.isAbsolute(outName) ? outName : path.join(outDir, outName);
    const overwrite = args.overwrite ?? false;
    checkOverwrite(outPath, overwrite);

    await logger.info("resolve", "combine start", {
      op: args.op,
      inputs: args.inputs,
      out: outPath,
      radius: args.radius ?? null,
    });

    const result = await runCombine(
      {
        op: args.op,
        inputs: args.inputs,
        out: outPath,
        radius: args.radius,
      },
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
  } catch (err) {
    await safeLogError(logger, (err as Error).message, {
      code: (err as { code?: string }).code ?? null,
    });
    throw err;
  } finally {
    await logger.close();
  }
}
