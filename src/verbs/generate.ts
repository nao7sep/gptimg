import path from "node:path";
import pLimit from "p-limit";
import { LocalOpError } from "../errors.js";
import { hash } from "../image/hash.js";
import { detectFormat } from "../image/detectFormat.js";
import {
  ensureOutputDir,
  writeOutputBytes,
} from "../internal/output-files.js";
import {
  assertOutputGroupAvailable,
  assertStemAvailable,
  createOutputGroup,
  plannedSidecarPaths,
  sidecarPathFor,
} from "../internal/output-group.js";
import { withVerbLogger } from "../internal/local-verb.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadProfile } from "../profile/load.js";
import { resolveProfile } from "../profile/resolve.js";
import { applySet } from "../recipe/applySet.js";
import { loadRecipe } from "../recipe/load.js";
import { validateChromaSection, validateGenerateSection } from "../recipe/schemas.js";
import { writeSidecar } from "../sidecar/write.js";
import { nullBase64InResponse } from "../sidecar/nullBase64.js";
import { getProvider } from "../providers/index.js";
import type {
  GenerateArgs,
  GenerateResult,
  OutputFile,
  Sidecar,
} from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateGenerateArgs } from "./schemas.js";
import {
  defaultOutDir,
  defaultProfilePath,
  defaultRecipePath,
  defaultStem,
  utcTimestamp,
} from "../internal/paths.js";
import { imageFileName } from "../internal/output-naming.js";

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
  const ts = utcTimestamp();
  const profilePath = args.profile ?? defaultProfilePath(ctx.profileDir);
  const recipePath = args.recipe ?? defaultRecipePath(ctx.profileDir);
  const signal = opts.signal;

  return withVerbLogger(ctx, "generate", { log: args.log, ts, onProgress: opts.onProgress }, async (logger) => {
    const profile = await loadProfile(profilePath);
    const resolved = resolveProfile(profile);
    await logger.info("resolve", "apiKey resolved", {
      apiKeySource: resolved.apiKeySource,
      provider: profile.provider,
    });

    let recipe = await loadRecipe(recipePath);
    if (args.set?.length) recipe = await applySet(recipe, "generate", args.set);
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
    const stem = args.outName ?? defaultStem(ts);
    const overwrite = args.overwrite ?? false;
    // Fail fast before the paid provider call when the stem already carries a
    // conflicting prior run. The per-image sidecars identify the group
    // independent of the image format, so this is checkable pre-response; the
    // full image+sidecar check still runs after the response as the authority.
    assertStemAvailable(outDir, stem, n, overwrite);

    await logger.info("request", "calling provider.generate", {
      provider: profile.provider,
      model: params.model ?? null,
      n,
    });

    const provider = getProvider(profile.provider);
    const providerResult = await provider.generate({
      prompt: args.prompt,
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

    const items = providerResult.images;
    const limit = pLimit(4);
    let partial = false;
    const suffixCount = Math.max(n, items.length);

    const plannedImages = (
      await Promise.all(
        items.map((item, i) =>
          limit(async () => {
            const index = i + 1;
            if (!item.data) {
              partial = true;
              await logger.warn("write", `image ${index} failed`, {
                index,
                error: item.error ?? null,
              });
              return null;
            }
            try {
              const fmt = await detectFormat(item.data);
              const fileName = imageFileName(stem, index, suffixCount, fmt.extension);
              const filePath = path.join(outDir, fileName);
              return { index, data: item.data, fmt, fileName, filePath };
            } catch (err) {
              partial = true;
              await logger.warn("write", `image ${index} format detection failed`, {
                index,
                error: (err as Error).message,
              });
              return null;
            }
          }),
        ),
      )
    ).filter((item): item is NonNullable<typeof item> => item !== null);

    const imageExts = new Set(plannedImages.map((item) => item.fmt.extension));
    if (imageExts.size > 1) {
      throw new LocalOpError(
        "output.mixedExtensions",
        `Provider returned images with mixed extensions (${[...imageExts].join(", ")}); the artifact group requires a single image format.`,
      );
    }
    const groupExt = plannedImages[0]?.fmt.extension ?? "png";
    const group = createOutputGroup(outDir, stem, groupExt);
    // One sidecar per image: <stem>.json for n=1, <stem>-NN.json for n>1.
    // The artifact group includes every per-image sidecar so overwrite logic
    // catches all of them as a single unit.
    const allSidecarPaths = plannedSidecarPaths(group, suffixCount, suffixCount);
    assertOutputGroupAvailable(
      group,
      [...plannedImages.map((item) => item.filePath), ...allSidecarPaths],
      overwrite,
    );

    const files: OutputFile[] = [];

    const requestRecord: Record<string, unknown> = {
      ...params,
      prompt: args.prompt,
      n,
    };
    if (chromaColor) requestRecord.chroma = { color: chromaColor };
    const redactedResponse = nullBase64InResponse(providerResult.raw);

    await Promise.all(
      plannedImages.map((item) =>
        limit(async () => {
          await writeOutputBytes(item.filePath, item.data);
          const sha = hash(item.data);
          // Per-image sidecar: same request and response across siblings (the
          // call is the same), but `files` carries only this image's entry so
          // each sidecar is self-describing.
          const itemSidecarPath = sidecarPathFor(group, item.index, suffixCount);
          const itemSidecarStem = itemSidecarPath.replace(/\.json$/, "");
          const itemSidecar: Sidecar = {
            request: requestRecord,
            response: redactedResponse,
            files: [
              {
                index: item.index,
                name: path.basename(item.filePath),
                sha256: sha,
                format: item.fmt.format,
              },
            ],
          };
          await writeSidecar(itemSidecarStem, itemSidecar);
          files.push({
            index: item.index,
            path: item.filePath,
            sidecarPath: itemSidecarPath,
            sha256: sha,
            format: item.fmt.format,
          });
          await logger.info("write", `wrote image ${item.index}`, {
            index: item.index,
            name: item.fileName,
            sha256: sha,
            format: item.fmt.format,
            sidecar: path.basename(itemSidecarPath),
          });
        }),
      ),
    );
    files.sort((a, b) => a.index - b.index);

    return {
      files,
      logPath: logger.handle.path,
      partial,
    };
  });
}
