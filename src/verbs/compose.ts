import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import {
  parseOverColor,
  runCompose,
  type ComposeOver,
} from "../local/compose.js";
import type { ComposeArgs, ComposeResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";

export interface ComposeContext {
  profileDir: string;
  logDir: string;
}

function defaultOutputName(input: string): string {
  return `${inferStem(input)}-composed.png`;
}

export async function composeImpl(
  ctx: ComposeContext,
  args: ComposeArgs,
  opts: VerbCallOptions = {},
): Promise<ComposeResult> {
  const signal = opts.signal;

  return withVerbLogger(ctx, "compose", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      outName: defaultOutputName(args.in),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    const over: ComposeOver | undefined = args.over
      ? parseOverColor(args.over)
      : undefined;

    await logger.info("resolve", "compose start", {
      input: args.in,
      mask: args.mask,
      out: outPath,
      over: over?.kind ?? "transparent",
      removeBleed: args.removeBleed ?? null,
    });

    const result = await runCompose(
      {
        in: args.in,
        mask: args.mask,
        out: outPath,
        over,
        removeBleed: args.removeBleed,
      },
      { signal },
    );
    await logger.info("write", "wrote composed image", {
      path: result.output,
      width: result.width,
      height: result.height,
      over: result.over,
    });

    return {
      input: args.in,
      mask: args.mask,
      output: result.output,
      width: result.width,
      height: result.height,
      over: result.over,
      logPath: logger.handle.path,
    };
  });
}
