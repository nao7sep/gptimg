import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runEncode } from "../local/encode.js";
import type { EncodeArgs, EncodeResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateEncodeArgs } from "./schemas.js";

export interface EncodeContext {
  profileDir: string;
  logDir: string;
}

function defaultStem(input: string): string {
  return `${inferStem(input)}-encode`;
}

export async function encodeImpl(
  ctx: EncodeContext,
  args: EncodeArgs,
  opts: VerbCallOptions = {},
): Promise<EncodeResult> {
  validateEncodeArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "encode", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: args.format,
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "encode start", {
      input: args.in,
      out: outPath,
      format: args.format,
      quality: args.quality ?? null,
      lossless: args.lossless ?? null,
      opaque: args.opaque ?? false,
    });

    const result = await runEncode(
      {
        in: args.in,
        out: outPath,
        format: args.format,
        quality: args.quality,
        lossless: args.lossless,
        opaque: args.opaque,
      },
      { signal },
    );

    await logger.info("write", "wrote encoded image", {
      path: result.output,
      format: result.format,
      width: result.width,
      height: result.height,
      alpha: result.alpha,
      quality: result.quality,
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
      quality: result.quality,
      lossless: result.lossless,
      sourceBytes: result.sourceBytes,
      bytes: result.bytes,
      logPath: logger.handle.path,
    };
  });
}
