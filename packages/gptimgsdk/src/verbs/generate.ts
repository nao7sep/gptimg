import { defaultModelFor } from "../ai-models.ts";
import { resolveModel } from "../providers/openai/client.ts";
import { ensureOutputDir } from "../internal/output-files.ts";
import {
  reserveOutputGroup,
  assertStemAvailable,
  createOutputGroup,
} from "../internal/output-group.ts";
import { withVerbLogger } from "../internal/local-verb.ts";
import { multiline } from "../internal/textCleanup.ts";
import { resolveNetworkForCall } from "../network/index.ts";
import { loadProfile } from "../profile/load.ts";
import { resolveProfile } from "../profile/resolve.ts";
import { mergeRecipes } from "../recipe/merge.ts";
import { loadRecipeForCall } from "../recipe/load.ts";
import { checkImageParams, resolveGenerateModeration } from "../recipe/model-check.ts";
import { validateChromaSection, validateGenerateSection } from "../recipe/schemas.ts";
import { getProvider } from "../providers/index.ts";
import type { GenerateArgs, GenerateResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { publishProviderImages } from "./image-outputs.ts";
import { validateGenerateArgs } from "./schemas.ts";
import {
  defaultProfilePath,
  defaultStem,
} from "../internal/paths.ts";

export interface GenerateContext {
  profileDir: string;
  logDir: string;
}

export async function generateImpl(
  ctx: GenerateContext,
  args: GenerateArgs,
  opts: VerbCallOptions = {},
): Promise<GenerateResult> {
  validateGenerateArgs(args);
  const profilePath = args.profile ?? defaultProfilePath(ctx.profileDir);
  const signal = opts.signal;
  // Normalize the free-text prompt once, at the input boundary, so the same
  // cleaned value is both sent to the provider and stored in the sidecar.
  // multiline() only drops edge blank lines and per-line trailing whitespace
  // (indentation and interior blanks preserved), so it is content-preserving
  // and safe for the outgoing request.
  const prompt = multiline(args.prompt);

  return withVerbLogger(ctx, "generate", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const profile = await loadProfile(profilePath);
    const resolved = resolveProfile(profile);
    await logger.info("resolve", "apiKey resolved", {
      apiKeySource: resolved.apiKeySource,
      provider: profile.provider,
    });

    let recipe = await loadRecipeForCall(args.recipe, ctx.profileDir);
    if (args.overrides) recipe = mergeRecipes(recipe, args.overrides);
    const network = resolveNetworkForCall(recipe);
    const section = validateGenerateSection(recipe.generate);
    const chromaSection = validateChromaSection(recipe.chroma);

    // The model, its moderation and its values are settled before the call, so the log and
    // the sidecar name what is sent.
    const model = resolveModel(section.model, defaultModelFor("openai", "image-generate"));
    const moderation = resolveGenerateModeration(model);
    const params: Record<string, unknown> = {
      ...section,
      model,
      ...(moderation !== undefined && { moderation }),
    };
    checkImageParams("generate", params);
    const chromaColor =
      typeof chromaSection.color === "string" && chromaSection.color.length > 0
        ? chromaSection.color
        : null;

    const n = typeof section.n === "number" && section.n > 0 ? section.n : 1;

    const outDir = args.outDir;
    await ensureOutputDir(outDir);
    const stem = args.outName ?? defaultStem();
    const overwrite = args.overwrite ?? false;
    // Reserve before the paid provider edge, so a live overlapping run in this
    // process fails without charging.
    using _outputReservation = await reserveOutputGroup(createOutputGroup(outDir, stem, "json"));
    // Sidecars identify the group independently of the eventual image format.
    assertStemAvailable(outDir, stem, n, overwrite);

    await logger.info("request", "calling provider.generate", {
      provider: profile.provider,
      model: params.model ?? null,
      n,
    });

    const provider = getProvider(profile.provider);
    const providerResult = await provider.generate({
      prompt,
      params,
      profile: resolved,
      network: {
        primary: network.imageGenerate,
        download: network.imageDownload,
        logger,
        signal,
      },
    });
    await logger.info("response", "provider.generate returned", {
      itemCount: providerResult.images.length,
    });

    const requestRecord: Record<string, unknown> = {
      ...params,
      prompt,
      n,
    };
    if (chromaColor) requestRecord.chroma = { color: chromaColor };
    const { files, partial } = await publishProviderImages({
      outDir,
      stem,
      n,
      overwrite,
      providerResult,
      requestRecord,
      credentials: [resolved.apiKey],
      logger,
    });

    return {
      files,
      logPath: logger.handle.path,
      partial,
    };
  });
}
