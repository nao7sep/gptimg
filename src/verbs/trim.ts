import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runTrim } from "../local/trim.js";
import type { TrimArgs, TrimResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateTrimArgs } from "./schemas.js";

export interface TrimContext {
  profileDir: string;
  logDir: string;
}

function defaultStem(input: string): string {
  return `${inferStem(input)}-trim`;
}

export async function trimImpl(
  ctx: TrimContext,
  args: TrimArgs,
  opts: VerbCallOptions = {},
): Promise<TrimResult> {
  validateTrimArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "trim", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: "png",
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "trim start", {
      input: args.in,
      out: outPath,
      margin: args.margin ?? null,
      square: args.square ?? false,
    });

    const result = await runTrim(
      {
        in: args.in,
        out: outPath,
        margin: args.margin,
        square: args.square,
      },
      { signal },
    );

    if (result.residueSuspected) {
      const o = result.overhang;
      const maxOverhang = Math.max(o.left, o.top, o.right, o.bottom);
      await logger.warn(
        "stats",
        `crop bbox overhangs the solid subject by up to ${maxOverhang}px ` +
          `(tolerance ${result.tolerance}px) — likely un-despeckled keying residue; ` +
          "run `gptimg despeckle` before trim",
        {
          bbox: result.bbox,
          solidBBox: result.solidBBox,
          overhang: result.overhang,
          tolerance: result.tolerance,
        },
      );
    }

    await logger.info("write", "wrote trimmed image", {
      path: result.output,
      width: result.width,
      height: result.height,
      bbox: result.bbox,
      marginPx: result.marginPx,
    });

    return {
      input: args.in,
      output: result.output,
      bbox: result.bbox,
      margin: result.margin,
      marginPx: result.marginPx,
      width: result.width,
      height: result.height,
      square: result.square,
      solidBBox: result.solidBBox,
      residueSuspected: result.residueSuspected,
      logPath: logger.handle.path,
    };
  });
}
