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
import { runLayer } from "../local/layer.ts";
import type { LayerArgs, LayerResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateLayerArgs } from "./schemas.ts";
import { extensionFor } from "../image/formats.ts";
import { ENCODING_DEFAULTS } from "../defaults.ts";

export type LayerContext = SdkContext;

function defaultStem(base: string): string {
  return `${inferStem(base)}-layered`;
}

export async function layerImpl(
  ctx: LayerContext,
  args: LayerArgs,
  opts: VerbCallOptions = {},
): Promise<LayerResult | RefusedResult> {
  validateLayerArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "layer", opts, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.base,
      stem: defaultStem(args.base),
      ext: extensionFor(args.format ?? ENCODING_DEFAULTS.format),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    logger.emit("info", "resolve", verbStart({
      base: args.base,
      top: args.top,
      out: outPath,
      scale: args.scale ?? null,
      gravity: args.gravity ?? null,
      topOffset: args.topOffset ?? null,
      ...encodingEventFields(args),
    }));

    const result = await runLayer(
      {
        base: args.base,
        top: args.top,
        out: outPath,
        overwrite: args.overwrite ?? false,
        ...encodingOf(args),
        scale: args.scale,
        gravity: args.gravity,
        topOffset: args.topOffset,
      },
      { signal },
    );

    logger.emit("info", "write", verbDone({
      path: result.output,
      width: result.width,
      height: result.height,
      topWidth: result.topWidth,
      topHeight: result.topHeight,
      gravity: result.gravity,
      topOffset: result.topOffset,
    }));

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
      status: "completed" as const,
    };
  });
}
