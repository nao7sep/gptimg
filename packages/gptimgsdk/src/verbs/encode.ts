import type { RefusedResult } from "../refusal.ts";
import type { SdkContext } from "../context.ts";
import {
  assertSingleFileAvailable,
  encodingLogFields,
  encodingOf,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.ts";
import { runEncode } from "../local/encode.ts";
import type { EncodeArgs, EncodeResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateEncodeArgs } from "./schemas.ts";

export type EncodeContext = SdkContext;

function defaultStem(input: string): string {
  return `${inferStem(input)}-encode`;
}

export async function encodeImpl(
  ctx: EncodeContext,
  args: EncodeArgs,
  opts: VerbCallOptions = {},
): Promise<EncodeResult | RefusedResult> {
  validateEncodeArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "encode", opts, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: args.format,
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "encode start", {
      input: args.in,
      out: outPath,
      ...encodingLogFields(args),
    });

    const result = await runEncode(
      {
        in: args.in,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        format: args.format,
      },
      { signal },
    );

    await logger.info("write", "wrote encoded image", {
      path: result.output,
      format: result.format,
      width: result.width,
      height: result.height,
      alpha: result.alpha,
      lossless: result.lossless,
      sourceBytes: result.sourceBytes,
      bytes: result.bytes,
    });

    return {
      input: args.in,
      output: result.output,
      format: result.format,
      width: result.width,
      height: result.height,
      alpha: result.alpha,
      lossless: result.lossless,
      sourceBytes: result.sourceBytes,
      bytes: result.bytes,
      logPath: logger.handle.path,
      status: "completed" as const,
    };
  });
}
