import { readFile } from "node:fs/promises";
import path from "node:path";
import { LocalOpError } from "../errors.js";
import { ensureOutputDir } from "../internal/output-files.js";
import { Logger, createLogger, safeLogError } from "../log/index.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadProfile } from "../profile/load.js";
import { resolveProfile } from "../profile/resolve.js";
import { applySet } from "../recipe/applySet.js";
import { loadRecipe } from "../recipe/load.js";
import { validateVisionSection } from "../recipe/schemas.js";
import { writeSidecar } from "../sidecar/write.js";
import { getProvider } from "../providers/index.js";
import { detectFormat } from "../image/detectFormat.js";
import { shrinkForVision } from "../image/shrinkForVision.js";
import type {
  Sidecar,
  VisionDetail,
  VisionArgs,
  VisionResult,
} from "../types.js";
import type { VerbCallOptions } from "./options.js";
import {
  defaultLogPath,
  defaultOutDir,
  defaultProfilePath,
  defaultRecipePath,
  defaultStem,
  utcTimestamp,
} from "../internal/paths.js";

import { VISION_DEFAULTS } from "./defaults.js";

export interface VisionContext {
  profileDir: string;
  logDir: string;
}

interface PreparedImage {
  path: string;
  data: Uint8Array;
  format: string;
  detail?: VisionDetail;
  shrink: {
    applied: boolean;
    originalWidth: number;
    originalHeight: number;
    outputWidth: number;
    outputHeight: number;
  };
}

async function prepareImage(
  imagePath: string,
  fit: { width: number; height: number },
  detail: VisionDetail | undefined,
  logger: Logger,
): Promise<PreparedImage> {
  let raw: Buffer;
  try {
    raw = await readFile(imagePath);
  } catch (err) {
    throw new LocalOpError(
      "image.readFailed",
      `Failed to read image at ${imagePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const shrink = await shrinkForVision(raw, fit);
  await logger.info("write", "prepared vision input", {
    path: path.basename(imagePath),
    shrink: {
      applied: shrink.applied,
      originalWidth: shrink.originalWidth,
      originalHeight: shrink.originalHeight,
      outputWidth: shrink.outputWidth,
      outputHeight: shrink.outputHeight,
    },
  });
  const fmt = await detectFormat(shrink.buffer);
  return {
    path: imagePath,
    data: new Uint8Array(shrink.buffer),
    format: fmt.format,
    detail,
    shrink: {
      applied: shrink.applied,
      originalWidth: shrink.originalWidth,
      originalHeight: shrink.originalHeight,
      outputWidth: shrink.outputWidth,
      outputHeight: shrink.outputHeight,
    },
  };
}

export async function visionImpl(
  ctx: VisionContext,
  args: VisionArgs,
  opts: VerbCallOptions = {},
): Promise<VisionResult> {
  const ts = utcTimestamp();
  const profilePath = args.profile ?? defaultProfilePath(ctx.profileDir);
  const recipePath = args.recipe ?? defaultRecipePath(ctx.profileDir);
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const logger = await createLogger(logPath, "vision");
  const signal = opts.signal;

  try {
    const profile = await loadProfile(profilePath);
    const resolved = resolveProfile(profile);
    await logger.info("resolve", "apiKey resolved", {
      apiKeySource: resolved.apiKeySource,
      provider: profile.provider,
    });

    let recipe = await loadRecipe(recipePath);
    if (args.set?.length) recipe = await applySet(recipe, "vision", args.set);
    const network = resolveNetworkForCall(recipe);
    const section = validateVisionSection(recipe.vision);
    const { shrink: configuredShrink, detail, ...params } = section;
    const shrink = configuredShrink ?? VISION_DEFAULTS.shrink;

    const inputs = Array.isArray(args.in) ? args.in : [args.in];
    const prepared = await Promise.all(
      inputs.map((p) => prepareImage(p, shrink, detail, logger)),
    );

    await logger.info("request", "calling provider.vision", {
      provider: profile.provider,
      model: params.model ?? null,
      images: prepared.length,
    });

    const provider = getProvider(profile.provider);
    const providerResult = await provider.vision({
      check: args.check,
      images: prepared.map((p) => ({
        data: p.data,
        format: p.format,
        ...(p.detail ? { detail: p.detail } : {}),
      })),
      params,
      profile: resolved,
      network: {
        primary: network.imageVision,
        download: network.imageDownload,
        logger,
        signal,
      },
    });
    await logger.info("response", "provider.vision returned", {
      ok: providerResult.verdict.ok,
      score: providerResult.verdict.score,
    });

    const outDir = args.outDir ?? defaultOutDir(ctx.profileDir);
    await ensureOutputDir(outDir);
    const stem = args.outName ?? defaultStem(ts);
    const stemPath = path.join(outDir, stem);

    const sidecar: Sidecar = {
      request: {
        ...params,
        check: args.check,
        ...(detail ? { detail } : {}),
        inputs: prepared.map((p) => ({
          name: path.basename(p.path),
          shrink: p.shrink,
        })),
      },
      response: {
        verdict: providerResult.verdict,
        raw: providerResult.raw,
      },
      files: [],
    };
    const sidecarPath = await writeSidecar(stemPath, sidecar);
    await logger.info("write", "wrote sidecar", {
      name: path.basename(sidecarPath),
    });

    return {
      ok: providerResult.verdict.ok,
      score: providerResult.verdict.score,
      reasons: providerResult.verdict.reasons,
      raw: providerResult.raw,
      sidecarPath,
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
