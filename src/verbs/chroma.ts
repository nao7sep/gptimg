import { createLogger, safeLogError } from "../log/index.js";
import { runChroma } from "../local/chroma/index.js";
import { loadRecipe } from "../recipe/load.js";
import { validateChromaSection } from "../recipe/schemas.js";
import type {
  ChromaArgs,
  ChromaRecipe,
  ChromaResult,
} from "../types.js";
import {
  defaultLogPath,
  defaultRecipePath,
  utcTimestamp,
} from "../internal/paths.js";
import type { VerbCallOptions } from "./options.js";

export interface ChromaContext {
  profileDir: string;
  logDir: string;
}

/**
 * Per-field merge: CLI/SDK args win; recipe fills in everything unset.
 * Anything still unset is filled by CHROMA_DEFAULTS inside runChroma.
 */
function applyRecipeDefaults(args: ChromaArgs, section: ChromaRecipe): ChromaArgs {
  const merged: ChromaArgs = { ...args };
  if (merged.preserveInterior === undefined && section.preserveInterior !== undefined) {
    merged.preserveInterior = section.preserveInterior;
  }
  if (
    merged.key === undefined &&
    typeof section.color === "string" &&
    section.color.length > 0
  ) {
    // recipe.chroma.color acts as an explicit key default when the caller
    // hasn't passed --key.
    merged.key = section.color;
  }
  if (merged.innerThreshold === undefined && section.innerThreshold !== undefined) {
    merged.innerThreshold = section.innerThreshold;
  }
  if (merged.borderSample === undefined && section.borderSample !== undefined) {
    merged.borderSample = section.borderSample;
  }
  if (merged.fillHoles === undefined && section.fillHoles !== undefined) {
    merged.fillHoles = section.fillHoles;
  }
  if (merged.strictConfidence === undefined && section.strictConfidence !== undefined) {
    merged.strictConfidence = section.strictConfidence;
  }
  return merged;
}

export async function chromaImpl(
  ctx: ChromaContext,
  args: ChromaArgs,
  opts: VerbCallOptions = {},
): Promise<ChromaResult> {
  const ts = utcTimestamp();
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const recipePath = args.recipe ?? defaultRecipePath(ctx.profileDir);
  const logger = await createLogger(logPath, "chroma");
  const signal = opts.signal;

  try {
    const recipe = await loadRecipe(recipePath);
    const chromaSection = validateChromaSection(recipe.chroma);
    const resolved = applyRecipeDefaults(args, chromaSection);

    await logger.info("resolve", "chroma start", {
      input: resolved.in,
      preserveInterior: resolved.preserveInterior ?? false,
      key: resolved.key ?? "auto",
    });

    const out = await runChroma(resolved, { signal });
    await logger.info("stats", "chroma complete", {
      output: out.imagePath,
      mask: out.maskPath,
      stats: out.stats,
    });

    return {
      input: resolved.in,
      outputs: { image: out.imagePath, mask: out.maskPath },
      stats: out.stats,
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
