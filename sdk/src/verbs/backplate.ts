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
import { runBackplate } from "../local/backplate.ts";
import type { BackplateArgs, BackplateResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateBackplateArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";
import { BACKPLATE_DEFAULTS, ENCODING_DEFAULTS } from "../defaults.ts";

export type BackplateContext = SdkContext;

function defaultStem(size: number): string {
  return `backplate-${size}`;
}

export async function backplateImpl(
  ctx: BackplateContext,
  args: BackplateArgs,
  opts: VerbCallOptions = {},
): Promise<BackplateResult | RefusedResult> {
  validateBackplateArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "backplate", opts, async (logger) => {
    // Resolve size only — runBackplate resolves the rest. The output name
    // depends on the final size; everything else just goes into the start event via
    // result fields after the call.
    const size = args.size ?? BACKPLATE_DEFAULTS.size;
    const outPath = await resolveOutputPath(args, {
      stem: defaultStem(size),
      ext: extensionFor(args.format ?? ENCODING_DEFAULTS.format),
    });
    await assertSingleFileAvailable(outPath, args.overwrite ?? false);

    logger.emit("info", "resolve", verbStart({
      out: outPath,
      size: args.size ?? null,
      content: args.content ?? null,
      radius: args.radius ?? null,
      angle: args.angle ?? null,
      shape: args.shape ?? null,
      from: args.from,
      to: args.to,
      ...encodingEventFields(args),
    }));

    const result = await runBackplate(
      {
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        size: args.size,
        content: args.content,
        radius: args.radius,
        from: args.from,
        to: args.to,
        angle: args.angle,
        shape: args.shape,
      },
      { signal },
    );

    logger.emit("info", "write", verbDone({
      path: result.output,
      size: result.size,
      content: result.content,
      radius: result.radius,
      angle: result.angle,
      shape: result.shape,
    }));

    return {
      output: result.output,
      size: result.size,
      content: result.content,
      radius: result.radius,
      shape: result.shape,
      from: result.from,
      to: result.to,
      angle: result.angle,
      status: "completed" as const,
    };
  });
}
