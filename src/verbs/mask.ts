import path from "node:path";
import { existsSync } from "node:fs";
import { LocalOpError } from "../errors.js";
import { writeMaskPNG } from "../image/bridge.js";
import { ensureOutputDir } from "../internal/output-files.js";
import { createLogger, safeLogError } from "../log/index.js";
import { aiMaskFromFile } from "../local/ai-mask.js";
import { chromaMaskFromFile } from "../local/chroma/mask.js";
import { loadRecipe } from "../recipe/load.js";
import { validateChromaSection } from "../recipe/schemas.js";
import type {
  MaskArgs,
  MaskRecipe,
  MaskResult,
  MaskStats,
} from "../types.js";
import {
  defaultLogPath,
  defaultModelsDir,
  defaultRecipePath,
  utcTimestamp,
} from "../internal/paths.js";
import type { VerbCallOptions } from "./options.js";

export interface MaskContext {
  profileDir: string;
  logDir: string;
}

function inferStem(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function defaultOutputName(input: string): string {
  return `${inferStem(input)}-mask.png`;
}

function applyChromaRecipeDefaults(
  args: MaskArgs,
  section: MaskRecipe,
): MaskArgs {
  const merged: MaskArgs = { ...args };
  if (merged.preserveInterior === undefined && section.preserveInterior !== undefined) {
    merged.preserveInterior = section.preserveInterior;
  }
  if (
    merged.key === undefined &&
    typeof section.color === "string" &&
    section.color.length > 0
  ) {
    merged.key = section.color;
  }
  if (merged.borderSample === undefined && section.borderSample !== undefined) {
    merged.borderSample = section.borderSample;
  }
  if (merged.saturationRatio === undefined && section.saturationRatio !== undefined) {
    merged.saturationRatio = section.saturationRatio;
  }
  return merged;
}

function checkOverwrite(filePath: string, allowOverwrite: boolean): void {
  if (!allowOverwrite && existsSync(filePath)) {
    throw new LocalOpError(
      "output.exists",
      `Output exists: ${filePath}. Use --overwrite to allow.`,
    );
  }
}

export async function maskImpl(
  ctx: MaskContext,
  args: MaskArgs,
  opts: VerbCallOptions = {},
): Promise<MaskResult> {
  const ts = utcTimestamp();
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const recipePath = args.recipe ?? defaultRecipePath(ctx.profileDir);
  const logger = await createLogger(logPath, "mask");
  const signal = opts.signal;

  try {
    const method = args.method ?? "chroma";

    let alpha: Uint8Array;
    let width: number;
    let height: number;
    let stats: MaskStats;
    let resolvedKey: string | undefined;
    let resolvedPreserveInterior: boolean | undefined;

    if (method === "chroma") {
      const recipe = await loadRecipe(recipePath);
      const chromaSection = validateChromaSection(recipe.chroma);
      const resolved = applyChromaRecipeDefaults(args, chromaSection);
      resolvedKey = resolved.key;
      resolvedPreserveInterior = resolved.preserveInterior;

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
      await logger.info("resolve", "mask start", {
        input: args.in,
        method,
        dryRun: args.dryRun ?? false,
      });

      const cacheDir = defaultModelsDir(ctx.profileDir);
      const result = await aiMaskFromFile(
        { in: args.in },
        cacheDir,
        { signal },
      );
      alpha = result.alpha;
      width = result.width;
      height = result.height;
      stats = result.stats;
    } else {
      throw new LocalOpError(
        "image.formatUnknown",
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

    const inDir = path.dirname(args.in);
    const outDir = args.outDir ?? inDir;
    await ensureOutputDir(outDir);
    const outName = args.outName ?? defaultOutputName(args.in);
    const outPath = path.isAbsolute(outName) ? outName : path.join(outDir, outName);
    const overwrite = args.overwrite ?? false;
    checkOverwrite(outPath, overwrite);

    await writeMaskPNG(alpha, width, height, outPath);
    await logger.info("write", "wrote mask", { path: outPath });

    // Silence unused warnings for chroma-only resolved values; they were
    // logged above already.
    void resolvedKey;
    void resolvedPreserveInterior;

    return {
      input: args.in,
      output: outPath,
      stats,
      logPath: logger.handle.path,
    };
  } catch (err) {
    await safeLogError(logger, (err as Error).message, {
      code: (err as { code?: string }).code ?? null,
    });
    throw err;
  } finally {
    await logger.close();
  }
}
