import { LocalOpError } from "../errors.js";
import { writeMaskPNG } from "../image/bridge.js";
import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { aiMaskFromFile } from "../local/ai-mask.js";
import { chromaMaskFromFile } from "../local/chroma/mask.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadRecipeForCall } from "../recipe/load.js";
import { validateChromaSection } from "../recipe/schemas.js";
import type {
  MaskArgs,
  MaskResult,
  MaskStats,
} from "../types.js";
import { defaultModelsDir } from "../internal/paths.js";
import type { VerbCallOptions } from "./options.js";
import { applyChromaRecipeDefaults } from "./mask-defaults.js";
import { validateMaskArgs } from "./schemas.js";

export interface MaskContext {
  profileDir: string;
  logDir: string;
}

function defaultStem(input: string): string {
  return `${inferStem(input)}-mask`;
}

export async function maskImpl(
  ctx: MaskContext,
  args: MaskArgs,
  opts: VerbCallOptions = {},
): Promise<MaskResult> {
  validateMaskArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "mask", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const method = args.method ?? "chroma";
    const recipe = await loadRecipeForCall(args.recipe, ctx.profileDir);

    let alpha: Uint8Array;
    let width: number;
    let height: number;
    let stats: MaskStats;

    if (method === "chroma") {
      const chromaSection = validateChromaSection(recipe.chroma);
      const resolved = applyChromaRecipeDefaults(args, chromaSection);

      await logger.info("resolve", "mask start", {
        input: resolved.in,
        method,
        key: resolved.key ?? "auto",
        preserveInterior: resolved.preserveInterior ?? false,
        dryRun: resolved.dryRun ?? false,
      });

      const result = await chromaMaskFromFile(
        {
          in: resolved.in,
          key: resolved.key,
          preserveInterior: resolved.preserveInterior,
          borderSample: resolved.borderSample,
          saturationRatio: resolved.saturationRatio,
        },
        { signal },
      );
      alpha = result.alpha;
      width = result.width;
      height = result.height;
      stats = result.stats;
    } else if (method === "ai") {
      const network = resolveNetworkForCall(recipe);
      await logger.info("resolve", "mask start", {
        input: args.in,
        method,
        dryRun: args.dryRun ?? false,
      });

      const cacheDir = defaultModelsDir(ctx.profileDir);
      const result = await aiMaskFromFile(
        { in: args.in },
        cacheDir,
        { signal, budget: network.modelDownload, logger },
      );
      alpha = result.alpha;
      width = result.width;
      height = result.height;
      stats = result.stats;
    } else {
      throw new LocalOpError(
        "args.invalid",
        `mask method "${method}" is not implemented.`,
      );
    }

    await logger.info("stats", "mask complete", { stats });

    if (args.dryRun) {
      return {
        input: args.in,
        output: null,
        stats,
        logPath: logger.handle.path,
      };
    }

    const outPath = await resolveOutputPath(args, {
      inputForDir: args.in,
      stem: defaultStem(args.in),
      ext: "png",
    });
    assertSingleFileAvailable(outPath, args.overwrite ?? false);

    await writeMaskPNG(alpha, width, height, outPath);
    await logger.info("write", "wrote mask", { path: outPath });

    return {
      input: args.in,
      output: outPath,
      stats,
      logPath: logger.handle.path,
    };
  });
}
