import path from "node:path";
import {
  assertSingleFileAvailable,
  withVerbLogger,
} from "../internal/local-verb.js";
import { ensureOutputDir } from "../internal/output-files.js";
import { ICON_DEFAULTS, planIconOutputs, runIcon } from "../local/icon.js";
import type { IconArgs, IconResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";

export interface IconContext {
  profileDir: string;
  logDir: string;
}

export async function iconImpl(
  ctx: IconContext,
  args: IconArgs,
  opts: VerbCallOptions = {},
): Promise<IconResult> {
  const signal = opts.signal;

  return withVerbLogger(ctx, "icon", args.log, async (logger) => {
    const outDir = args.outDir ?? path.dirname(args.in);
    await ensureOutputDir(outDir);
    const name = args.name ?? ICON_DEFAULTS.name;
    const pngs = args.pngs ?? ICON_DEFAULTS.pngs;

    const plan = planIconOutputs(outDir, name, pngs);
    for (const filePath of plan.all) {
      assertSingleFileAvailable(filePath, args.overwrite ?? false);
    }

    await logger.info("resolve", "icon start", {
      in: args.in,
      outDir,
      name,
      pngs,
    });

    const result = await runIcon({ in: args.in, outDir, name, pngs }, { signal });

    await logger.info("write", "wrote icon artifacts", {
      outputs: result.outputs,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
    });

    return {
      input: args.in,
      outputs: result.outputs,
      icns: result.icns,
      ico: result.ico,
      png: result.png,
      pngs: result.pngSet.map((p) => p.path),
      width: result.sourceWidth,
      height: result.sourceHeight,
      logPath: logger.handle.path,
    };
  });
}
