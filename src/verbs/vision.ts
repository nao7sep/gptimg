import { readFile } from "node:fs/promises";
import path from "node:path";
import { LocalOpError } from "../errors.js";
import { ensureOutputDir } from "../internal/output-files.js";
import { assertSingleFileAvailable, withVerbLogger } from "../internal/local-verb.js";
import { singleLine } from "../internal/textCleanup.js";
import type { Logger } from "../log/index.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadProfile } from "../profile/load.js";
import { resolveProfile } from "../profile/resolve.js";
import { mergeRecipes } from "../recipe/merge.js";
import { loadRecipeForCall } from "../recipe/load.js";
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
import { validateVisionArgs } from "./schemas.js";
import {
  defaultOutDir,
  defaultProfilePath,
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
  validateVisionArgs(args);
  const ts = utcTimestamp();
  const profilePath = args.profile ?? defaultProfilePath(ctx.profileDir);
  const signal = opts.signal;
  // The check is a scalar instruction; normalize it to a single line once at the
  // input boundary so the same cleaned value is sent to the model and stored in
  // the sidecar.
  const check = singleLine(args.check);

  return withVerbLogger(ctx, "vision", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const profile = await loadProfile(profilePath);
    const resolved = resolveProfile(profile);
    await logger.info("resolve", "apiKey resolved", {
      apiKeySource: resolved.apiKeySource,
      provider: profile.provider,
    });

    let recipe = await loadRecipeForCall(args.recipe, ctx.profileDir);
    if (args.overrides) recipe = mergeRecipes(recipe, args.overrides);
    const network = resolveNetworkForCall(recipe);
    const section = validateVisionSection(recipe.vision);
    const { shrink: configuredShrink, detail, ...params } = section;
    const shrink = configuredShrink ?? VISION_DEFAULTS.shrink;

    // Resolve + guard the sidecar path before the (paid) provider call so a
    // name collision fails fast without spending, like generate/edit.
    const outDir = args.outDir ?? defaultOutDir(ctx.profileDir);
    await ensureOutputDir(outDir);
    const stem = args.outName ?? defaultStem(ts);
    const stemPath = path.join(outDir, stem);
    assertSingleFileAvailable(`${stemPath}.json`, args.overwrite ?? false);

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
      check,
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

    const sidecar: Sidecar = {
      request: {
        ...params,
        check,
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
  });
}
