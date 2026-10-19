import { verbDone, verbStart } from "../events/index.ts";
import type { RefusedResult } from "../refusal.ts";
import type { SdkContext } from "../context.ts";
import {
  assertSingleFileAvailable,
  encodingEventFields,
  encodingOf,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.ts";
import { runGrid } from "../local/grid.ts";
import type { GridArgs, GridResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateGridArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";

export type GridContext = SdkContext;

export async function gridImpl(
  ctx: GridContext,
  args: GridArgs,
  opts: VerbCallOptions = {},
): Promise<GridResult | RefusedResult> {
  validateGridArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "grid", opts, async (logger) => {
    // The sheet lands beside its first input by default — the inputs are the
    // natural base directory for a comparison of them. The schema guarantees at
    // least one input.
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.inputs[0]!,
      stem: "grid",
      ext: extensionFor(args.format ?? "png"),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    logger.emit("info", "resolve", verbStart({
      out: outPath,
      inputs: args.inputs.length,
      cols: args.cols ?? null,
      cell: args.cell ?? null,
      gap: args.gap ?? null,
      background: args.background ?? null,
      ...encodingEventFields(args),
    }));

    const result = await runGrid(
      {
        inputs: args.inputs,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        cols: args.cols,
        cell: args.cell,
        gap: args.gap,
        background: args.background,
      },
      { signal, logger },
    );

    logger.emit("info", "write", verbDone({
      path: result.output,
      placed: result.placed,
      skipped: result.skipped,
      cols: result.cols,
      rows: result.rows,
      width: result.width,
      height: result.height,
    }));

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
      status: "completed" as const,
    };
  });
}
