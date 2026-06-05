import {
  assertSingleFileAvailable,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { BACKPLATE_DEFAULTS, runBackplate } from "../local/backplate.js";
import type { BackplateArgs, BackplateResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";

export interface BackplateContext {
  profileDir: string;
  logDir: string;
}

function defaultOutputName(size: number): string {
  return `backplate-${size}.png`;
}

export async function backplateImpl(
  ctx: BackplateContext,
  args: BackplateArgs,
  opts: VerbCallOptions = {},
): Promise<BackplateResult> {
  const signal = opts.signal;

  return withVerbLogger(ctx, "backplate", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    // Resolve size only — runBackplate resolves the rest. The output name
    // depends on the final size; everything else just goes into the log via
    // result fields after the call.
    const size = args.size ?? BACKPLATE_DEFAULTS.size;
    const outPath = await resolveOutputPath(args, {
      outName: defaultOutputName(size),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "backplate start", {
      out: outPath,
      size: args.size ?? null,
      content: args.content ?? null,
      radius: args.radius ?? null,
      angle: args.angle ?? null,
      shape: args.shape ?? null,
      from: args.from,
      to: args.to,
    });

    const result = await runBackplate(
      {
        out: outPath,
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

    await logger.info("write", "wrote backplate", {
      path: result.output,
      size: result.size,
      content: result.content,
      radius: result.radius,
      angle: result.angle,
      shape: result.shape,
    });

    return {
      output: result.output,
      size: result.size,
      content: result.content,
      radius: result.radius,
      shape: result.shape,
      from: result.from,
      to: result.to,
      angle: result.angle,
      logPath: logger.handle.path,
    };
  });
}
