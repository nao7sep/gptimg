import path from "node:path";
import { createLogger, safeLogError } from "../log/index.js";
import { runChroma } from "../local/chroma/index.js";
import {
  verifyChromaAlpha,
  writeCheckerboardPreview,
} from "../local/chroma/verifyAlpha.js";
import { CHROMA_VERIFY_INSTRUCTION } from "../local/chroma/defaults.js";
import { loadRecipe } from "../recipe/load.js";
import { validateChromaSection } from "../recipe/schemas.js";
import { visionImpl, type VisionContext } from "./vision.js";
import type {
  ChromaAlphaVerifyResult,
  ChromaArgs,
  ChromaRecipe,
  ChromaResult,
  VisionResult,
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
    (merged.key === undefined || merged.key === "auto") &&
    typeof section.color === "string" &&
    section.color.length > 0
  ) {
    // recipe.chroma.color acts as an explicit key default when the caller
    // hasn't asked for auto-detect explicitly.
    if (merged.key === undefined) merged.key = section.color;
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
  if (merged.verifyThreshold === undefined && section.verifyThreshold !== undefined) {
    merged.verifyThreshold = section.verifyThreshold;
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

    let verify: VisionResult | undefined;
    let previewPath: string | undefined;
    let alphaVerify: ChromaAlphaVerifyResult | undefined;
    const verifyThreshold = resolved.verifyThreshold ?? 0;
    if (resolved.verify && out.stats.removedFraction > verifyThreshold) {
      alphaVerify = await verifyChromaAlpha(out.imagePath, {
        key: out.stats.key,
        preserveInterior: out.stats.preserveInterior,
        expectInteriorTransparency: out.stats.regionsRemoved.some(
          (region) => !region.touchesBorder,
        ),
      });
      await logger.info("stats", "local alpha verification complete", {
        ok: alphaVerify.ok,
        score: alphaVerify.score,
        metrics: alphaVerify.metrics,
      });

      const visionCtx: VisionContext = {
        profileDir: ctx.profileDir,
        logDir: ctx.logDir,
      };
      previewPath = path.join(
        path.dirname(out.imagePath),
        `${path.parse(out.imagePath).name}-verify-preview.png`,
      );
      await writeCheckerboardPreview(out.imagePath, previewPath);
      await logger.info("request", "running internal vision verification", {
        threshold: verifyThreshold,
        removedFraction: out.stats.removedFraction,
        preview: path.basename(previewPath),
      });
      const verifyInstruction =
        chromaSection.verifyInstruction ?? CHROMA_VERIFY_INSTRUCTION;
      verify = await visionImpl(
        visionCtx,
        {
          in: previewPath,
          check: `${resolved.verify}\n\n${verifyInstruction}`,
          log: logger.handle.path,
          outDir: path.dirname(out.imagePath),
          outName: `${path.parse(out.imagePath).name}-verify`,
        },
        { signal },
      );
      await logger.info("response", "vision verification returned", {
        ok: verify.ok,
        score: verify.score,
      });
    }

    return {
      input: resolved.in,
      outputs: { image: out.imagePath, mask: out.maskPath },
      stats: out.stats,
      ...(alphaVerify ? { alphaVerify } : {}),
      ...(verify ? { verify: { ...verify, ...(previewPath ? { previewPath } : {}) } } : {}),
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
