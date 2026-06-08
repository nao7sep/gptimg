import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { defaultModelsDir, defaultRecipePath } from "../internal/paths.js";
import { runUpscale } from "../local/upscale.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadRecipe } from "../recipe/load.js";
import type { UpscaleArgs, UpscaleResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateUpscaleArgs } from "./schemas.js";

export interface UpscaleContext {
  profileDir: string;
  logDir: string;
}

function defaultOutputName(input: string): string {
  return `${inferStem(input)}-upscale.png`;
}

export async function upscaleImpl(
  ctx: UpscaleContext,
  args: UpscaleArgs,
  opts: VerbCallOptions = {},
): Promise<UpscaleResult> {
  validateUpscaleArgs(args);
  const signal = opts.signal;
  const recipePath = args.recipe ?? defaultRecipePath(ctx.profileDir);

  return withVerbLogger(ctx, "upscale", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      outName: defaultOutputName(args.in),
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    const network = resolveNetworkForCall(await loadRecipe(recipePath));
    const cacheDir = defaultModelsDir(ctx.profileDir);

    await logger.info("resolve", "upscale start", {
      input: args.in,
      out: outPath,
      toSize: args.toSize ?? null,
      kernel: args.kernel ?? null,
      tile: args.tile ?? null,
    });

    const result = await runUpscale(
      {
        in: args.in,
        out: outPath,
        toSize: args.toSize,
        kernel: args.kernel,
        tile: args.tile,
      },
      cacheDir,
      { signal, budget: network.modelDownload, logger },
    );

    await logger.info("write", "wrote upscaled image", {
      path: result.output,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      modelWidth: result.modelWidth,
      modelHeight: result.modelHeight,
      width: result.width,
      height: result.height,
      tiles: result.tiles,
    });

    return {
      input: args.in,
      output: result.output,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      modelWidth: result.modelWidth,
      modelHeight: result.modelHeight,
      width: result.width,
      height: result.height,
      toSize: result.toSize,
      kernel: result.kernel,
      tile: result.tile,
      tiles: result.tiles,
      logPath: logger.handle.path,
    };
  });
}
