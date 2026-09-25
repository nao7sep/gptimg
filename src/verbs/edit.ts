import { access } from "node:fs/promises";
import path from "node:path";
import { LocalOpError } from "../errors.js";
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
import { validateEditSection } from "../recipe/schemas.js";
import { getProvider } from "../providers/index.js";
import type { EditArgs, EditResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { publishProviderImages } from "./image-outputs.js";
import { validateEditArgs } from "./schemas.js";
import {
  defaultOutDir,
  defaultProfilePath,
  defaultStem,
  utcTimestamp,
} from "../internal/paths.js";

export interface EditContext {
  profileDir: string;
  logDir: string;
}

async function assertReadableImage(filePath: string, label: string): Promise<void> {
  try {
    await access(filePath);
  } catch (err) {
    throw new LocalOpError(
      "image.readFailed",
      `Failed to read ${label} image at ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

export async function editImpl(
  ctx: EditContext,
  args: EditArgs,
  opts: VerbCallOptions = {},
): Promise<EditResult> {
  validateEditArgs(args);
  const ts = utcTimestamp();
  const profilePath = args.profile ?? defaultProfilePath(ctx.profileDir);
  const signal = opts.signal;
  // Normalize the free-text prompt once, at the input boundary, so the same
  // cleaned value is both sent to the provider and stored in the sidecar.
  // multiline() is content-preserving (drops only edge blank lines and per-line
  // trailing whitespace), so it is safe for the outgoing request.
  const prompt = multiline(args.prompt);

  return withVerbLogger(ctx, "edit", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const profile = await loadProfile(profilePath);
    const resolved = resolveProfile(profile);
    await logger.info("resolve", "apiKey resolved", {
      apiKeySource: resolved.apiKeySource,
      provider: profile.provider,
    });

    let recipe = await loadRecipeForCall(args.recipe, ctx.profileDir);
    if (args.overrides) recipe = mergeRecipes(recipe, args.overrides);
    const network = resolveNetworkForCall(recipe);
    const section = validateEditSection(recipe.edit);
    const params: Record<string, unknown> = { ...section };

    const n =
      typeof params.n === "number" && (params.n as number) > 0
        ? (params.n as number)
        : 1;

    await assertReadableImage(args.in, "input");
    if (args.mask) await assertReadableImage(args.mask, "mask");

    const outDir = args.outDir ?? defaultOutDir(ctx.profileDir);
    await ensureOutputDir(outDir);
    const stem = args.outName ?? defaultStem(ts);
    const overwrite = args.overwrite ?? false;
    await using _outputLock = await acquireOutputGroupLock(createOutputGroup(outDir, stem, "json"));
    // Fail before the paid provider call when this stem already conflicts.
    assertStemAvailable(outDir, stem, n, overwrite);

    await logger.info("request", "calling provider.edit", {
      provider: profile.provider,
      model: params.model ?? null,
      input: path.basename(args.in),
      mask: args.mask ? path.basename(args.mask) : null,
      n,
    });

    const provider = getProvider(profile.provider);
    const providerResult = await provider.edit({
      prompt,
      imagePath: args.in,
      maskPath: args.mask,
      params,
      profile: resolved,
      network: {
        primary: network.imageGenerate,
        download: network.imageDownload,
        logger,
        signal,
      },
    });
    await logger.info("response", "provider.edit returned", {
      itemCount: providerResult.images.length,
    });

    const requestRecord = {
      ...params,
      prompt,
      input: path.basename(args.in),
      mask: args.mask ? path.basename(args.mask) : null,
      n,
    };
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
