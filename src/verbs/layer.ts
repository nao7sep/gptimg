import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { runLayer } from "../local/layer.js";
import type { LayerArgs, LayerResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";

export interface LayerContext {
  profileDir: string;
  logDir: string;
}

function defaultOutputName(base: string): string {
  return `${inferStem(base)}-layered.png`;
}

export async function layerImpl(
  ctx: LayerContext,
  args: LayerArgs,
  opts: VerbCallOptions = {},
): Promise<LayerResult> {
  const signal = opts.signal;

  return withVerbLogger(ctx, "layer", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.base,
      outName: defaultOutputName(args.base),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await logger.info("resolve", "layer start", {
      base: args.base,
      top: args.top,
      out: outPath,
      scale: args.scale ?? null,
      gravity: args.gravity ?? null,
      topOffset: args.topOffset ?? null,
    });

    const result = await runLayer(
      {
        base: args.base,
        top: args.top,
        out: outPath,
        scale: args.scale,
        gravity: args.gravity,
        topOffset: args.topOffset,
      },
      { signal },
    );

    await logger.info("write", "wrote layered image", {
      path: result.output,
      width: result.width,
      height: result.height,
      topWidth: result.topWidth,
      topHeight: result.topHeight,
      gravity: result.gravity,
      topOffset: result.topOffset,
    });

    return {
      base: args.base,
      top: args.top,
      output: result.output,
      width: result.width,
      height: result.height,
      topWidth: result.topWidth,
      topHeight: result.topHeight,
      gravity: result.gravity,
      topOffset: result.topOffset,
      logPath: logger.handle.path,
    };
  });
}
