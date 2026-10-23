import { verbDone, verbStart } from "../events/index.ts";
import type { RefusedResult } from "../refusal.ts";
import type { SdkContext } from "../context.ts";
import {
  assertSingleFileAvailable,
  encodingEventFields,
  encodingOf,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.ts";
import { runShadow } from "../local/shadow.ts";
import type { ShadowArgs, ShadowResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateShadowArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";
import { ENCODING_DEFAULTS } from "../defaults.ts";

export type ShadowContext = SdkContext;

function defaultStem(input: string): string {
  return `${inferStem(input)}-shadow`;
}

export async function shadowImpl(
  ctx: ShadowContext,
  args: ShadowArgs,
  opts: VerbCallOptions = {},
): Promise<ShadowResult | RefusedResult> {
  validateShadowArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "shadow", opts, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: extensionFor(args.format ?? ENCODING_DEFAULTS.format),
    });
    await assertSingleFileAvailable(outPath, args.overwrite ?? false);

    logger.emit("info", "resolve", verbStart({
      input: args.in,
      out: outPath,
      blur: args.blur ?? null,
      offset: args.offset ?? null,
      color: args.color ?? null,
      opacity: args.opacity ?? null,
      spread: args.spread ?? null,
      keepCanvas: args.keepCanvas ?? null,
      ...encodingEventFields(args),
    }));

    const result = await runShadow(
      {
        in: args.in,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        blur: args.blur,
        offset: args.offset,
        color: args.color,
        opacity: args.opacity,
        spread: args.spread,
        keepCanvas: args.keepCanvas,
      },
      { signal },
    );

    logger.emit("info", "write", verbDone({
      path: result.output,
      width: result.width,
      height: result.height,
      color: result.color,
      blur: result.blur,
    }));

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
      status: "completed" as const,
    };
  });
}
