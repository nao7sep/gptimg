import {
  assertSingleFileAvailable,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runGrid } from "../local/grid.js";
import type { GridArgs, GridResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateGridArgs } from "./schemas.js";

export interface GridContext {
  profileDir: string;
  logDir: string;
}

export async function gridImpl(
  ctx: GridContext,
  args: GridArgs,
  opts: VerbCallOptions = {},
): Promise<GridResult> {
  validateGridArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "grid", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    // The sheet lands beside its first input by default — the inputs are the
    // natural base directory for a comparison of them. The schema guarantees at
    // least one input.
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.inputs[0]!,
      stem: "grid",
      ext: "png",
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "grid start", {
      out: outPath,
      inputs: args.inputs.length,
      cols: args.cols ?? null,
      cell: args.cell ?? null,
      gap: args.gap ?? null,
      background: args.background ?? null,
    });

    const result = await runGrid(
      {
        inputs: args.inputs,
        out: outPath,
        cols: args.cols,
        cell: args.cell,
        gap: args.gap,
        background: args.background,
      },
      { signal },
    );

    await logger.info("write", "wrote grid sheet", {
      path: result.output,
      placed: result.placed,
      skipped: result.skipped,
      cols: result.cols,
      rows: result.rows,
      width: result.width,
      height: result.height,
    });

    return {
      output: result.output,
      count: result.count,
      placed: result.placed,
      skipped: result.skipped,
      cols: result.cols,
      rows: result.rows,
      cell: result.cell,
      gap: result.gap,
      width: result.width,
      height: result.height,
      logPath: logger.handle.path,
    };
  });
}
