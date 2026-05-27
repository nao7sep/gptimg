import { createLogger, safeLogError } from "../log/index.js";
import { runInspect } from "../local/inspect/index.js";
import { loadRecipe } from "../recipe/load.js";
import { validateChromaSection } from "../recipe/schemas.js";
import type { ChromaRecipe, InspectArgs, InspectResult } from "../types.js";
import {
  defaultLogPath,
  defaultRecipePath,
  utcTimestamp,
} from "../internal/paths.js";
import type { VerbCallOptions } from "./options.js";

export interface InspectContext {
  profileDir: string;
  logDir: string;
}

function applyRecipeDefaults(args: InspectArgs, section: ChromaRecipe): InspectArgs {
  const merged: InspectArgs = { ...args };
  if (merged.mode === undefined && section.mode !== undefined) merged.mode = section.mode;
  if (
    merged.key === undefined &&
    typeof section.color === "string" &&
    section.color.length > 0
  ) {
    merged.key = section.color;
  }
  if (merged.innerThreshold === undefined && section.innerThreshold !== undefined) {
    merged.innerThreshold = section.innerThreshold;
  }
  if (merged.borderSample === undefined && section.borderSample !== undefined) {
    merged.borderSample = section.borderSample;
  }
  if (merged.strictConfidence === undefined && section.strictConfidence !== undefined) {
    merged.strictConfidence = section.strictConfidence;
  }
  return merged;
}

export async function inspectImpl(
  ctx: InspectContext,
  args: InspectArgs,
  opts: VerbCallOptions = {},
): Promise<InspectResult> {
  const ts = utcTimestamp();
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const recipePath = args.recipe ?? defaultRecipePath(ctx.profileDir);
  const logger = await createLogger(logPath, "inspect");
  const signal = opts.signal;

  try {
    const recipe = await loadRecipe(recipePath);
    const chromaSection = validateChromaSection(recipe.chroma);
    const resolved = applyRecipeDefaults(args, chromaSection);

    await logger.info("resolve", "inspect start", {
      input: resolved.in,
      mode: resolved.mode ?? "outer",
      key: resolved.key ?? "auto",
    });
    const stats = await runInspect(resolved, { signal });
    await logger.info("stats", "inspect complete", { stats });
    return {
      input: resolved.in,
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
