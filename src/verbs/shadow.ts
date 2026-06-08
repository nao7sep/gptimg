import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runShadow } from "../local/shadow.js";
import type { ShadowArgs, ShadowResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateShadowArgs } from "./schemas.js";

export interface ShadowContext {
  profileDir: string;
  logDir: string;
}

function defaultOutputName(input: string): string {
  return `${inferStem(input)}-shadow.png`;
}

export async function shadowImpl(
  ctx: ShadowContext,
  args: ShadowArgs,
  opts: VerbCallOptions = {},
): Promise<ShadowResult> {
  validateShadowArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "shadow", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      outName: defaultOutputName(args.in),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "shadow start", {
      in: args.in,
      out: outPath,
      blur: args.blur ?? null,
      offset: args.offset ?? null,
      color: args.color ?? null,
      opacity: args.opacity ?? null,
      spread: args.spread ?? null,
      keepCanvas: args.keepCanvas ?? null,
    });

    const result = await runShadow(
      {
        in: args.in,
        out: outPath,
        blur: args.blur,
        offset: args.offset,
        color: args.color,
        opacity: args.opacity,
        spread: args.spread,
        keepCanvas: args.keepCanvas,
      },
      { signal },
    );

    await logger.info("write", "wrote shadowed image", {
      path: result.output,
      width: result.width,
      height: result.height,
      color: result.color,
      blur: result.blur,
    });

    return {
      input: args.in,
      output: result.output,
      width: result.width,
      height: result.height,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      blur: result.blur,
      offset: result.offset,
      color: result.color,
      opacity: result.opacity,
      spread: result.spread,
      keepCanvas: result.keepCanvas,
      logPath: logger.handle.path,
    };
  });
}
