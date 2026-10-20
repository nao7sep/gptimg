import { verbDone, verbStart } from "../events/index.ts";
import type { RefusedResult } from "../refusal.ts";
import type { SdkContext } from "../context.ts";
import path from "node:path";
import { outputStemLocation,
  assertSingleFileAvailable,
  pngEncodingEventFields,
  pngEncodingOf,
  withVerbLogger,
} from "../internal/local-verb.ts";
import { ensureOutputDir } from "../internal/output-files.ts";
import { planIconOutputs, runIcon } from "../local/icon.ts";
import type { IconArgs, IconResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateIconArgs } from "./schemas.ts";
import { ICON_DEFAULTS } from "../defaults.ts";

export type IconContext = SdkContext;

export async function iconImpl(
  ctx: IconContext,
  args: IconArgs,
  opts: VerbCallOptions = {},
): Promise<IconResult | RefusedResult> {
  validateIconArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "icon", opts, async (logger) => {
    const { outDir, stem: name } = outputStemLocation(args.outDir ?? path.dirname(args.in), args.outName ?? ICON_DEFAULTS.name);
    await ensureOutputDir(outDir);
    const pngs = args.pngs ?? ICON_DEFAULTS.pngs;

    const plan = planIconOutputs(outDir, name, pngs);
    for (const filePath of plan.all) {
      assertSingleFileAvailable(filePath, args.overwrite ?? false);
    }

    logger.emit("info", "resolve", verbStart({
      input: args.in,
      outDir,
      name,
      pngs,
      ...pngEncodingEventFields(args),
    }));

    const result = await runIcon(
      { in: args.in, outDir, name, pngs, overwrite: args.overwrite ?? false, ...pngEncodingOf(args) },
      { signal, logger },
    );

    logger.emit("info", "write", verbDone({
      outputs: result.outputs,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
    }));

    return {
      input: args.in,
      outputs: result.outputs,
      icns: result.icns,
      ico: result.ico,
      png: result.png,
      pngs: result.pngSet.map((p) => p.path),
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      status: "completed" as const,
    };
  });
}
