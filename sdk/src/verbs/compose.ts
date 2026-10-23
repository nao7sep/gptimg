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
import {
  parseOverColor,
  runCompose,
  type ComposeOver,
} from "../local/compose.ts";
import type { ComposeArgs, ComposeResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateComposeArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";
import { ENCODING_DEFAULTS } from "../defaults.ts";

export type ComposeContext = SdkContext;

function defaultStem(input: string): string {
  return `${inferStem(input)}-composed`;
}

export async function composeImpl(
  ctx: ComposeContext,
  args: ComposeArgs,
  opts: VerbCallOptions = {},
): Promise<ComposeResult | RefusedResult> {
  validateComposeArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "compose", opts, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: extensionFor(args.format ?? ENCODING_DEFAULTS.format),
    });
    await assertSingleFileAvailable(outPath, args.overwrite ?? false);

    const over: ComposeOver | undefined = args.over
      ? parseOverColor(args.over)
      : undefined;

    logger.emit("info", "resolve", verbStart({
      input: args.in,
      mask: args.mask,
      out: outPath,
      over: over?.kind ?? "transparent",
      removeBleed: args.removeBleed ?? null,
      ...encodingEventFields(args),
    }));

    const result = await runCompose(
      {
        in: args.in,
        mask: args.mask,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        over,
        removeBleed: args.removeBleed,
      },
      { signal },
    );
    logger.emit("info", "write", verbDone({
      path: result.output,
      width: result.width,
      height: result.height,
      over: result.over,
    }));

    return {
      input: args.in,
      mask: args.mask,
      output: result.output,
      width: result.width,
      height: result.height,
      over: result.over,
      status: "completed" as const,
    };
  });
}
