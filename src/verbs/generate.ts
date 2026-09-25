import { ensureOutputDir } from "../internal/output-files.js";
import {
  acquireOutputGroupLock,
  assertStemAvailable,
  createOutputGroup,
} from "../internal/output-group.js";
import { withVerbLogger } from "../internal/local-verb.js";
import { multiline } from "../internal/textCleanup.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadProfile } from "../profile/load.js";
import { resolveProfile } from "../profile/resolve.js";
import { mergeRecipes } from "../recipe/merge.js";
import { loadRecipeForCall } from "../recipe/load.js";
import { validateChromaSection, validateGenerateSection } from "../recipe/schemas.js";
import { getProvider } from "../providers/index.js";
import type { GenerateArgs, GenerateResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { publishProviderImages } from "./image-outputs.js";
import { validateGenerateArgs } from "./schemas.js";
import {
  defaultOutDir,
  defaultProfilePath,
  defaultStem,
} from "../internal/paths.js";

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

    const params: Record<string, unknown> = { ...section };
    const chromaColor =
      typeof chromaSection.color === "string" && chromaSection.color.length > 0
        ? chromaSection.color
        : null;

    const n = typeof section.n === "number" && section.n > 0 ? section.n : 1;

    const outDir = args.outDir ?? defaultOutDir(ctx.profileDir);
    await ensureOutputDir(outDir);
    const stem = args.outName ?? defaultStem();
    const overwrite = args.overwrite ?? false;
    // Reserve before the paid provider edge. A known-live contender therefore
    // fails without charging, while a crashed/released reservation is recovered.
    await using _outputLock = await acquireOutputGroupLock(createOutputGroup(outDir, stem, "json"));
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
      logger,
    });

    return {
      files,
      logPath: logger.handle.path,
      partial,
    };
  });
}
