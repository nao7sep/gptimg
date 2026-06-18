import { access } from "node:fs/promises";
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
import { mergeRecipes } from "../recipe/merge.js";
import { loadRecipeForCall } from "../recipe/load.js";
import { validateEditSection } from "../recipe/schemas.js";
import { nullBase64InResponse } from "../sidecar/nullBase64.js";
import { writeSidecar } from "../sidecar/write.js";
import { getProvider } from "../providers/index.js";
import type {
  EditArgs,
  EditResult,
  OutputFile,
  Sidecar,
} from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateEditArgs } from "./schemas.js";
import {
  defaultOutDir,
  defaultProfilePath,
  defaultStem,
  utcTimestamp,
} from "../internal/paths.js";
import { imageFileName } from "../internal/output-naming.js";

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
    // Fail fast before the paid provider call when the stem already conflicts
    // (sidecars identify the group independent of image format). The full
    // image+sidecar check still runs after the response as the authority.
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
      prompt: args.prompt,
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

    const limit = pLimit(4);
    let partial = false;
    const suffixCount = Math.max(n, providerResult.images.length);

    const plannedImages = (
      await Promise.all(
        providerResult.images.map((item, i) =>
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
    const allSidecarPaths = plannedSidecarPaths(group, suffixCount, suffixCount);
    assertOutputGroupAvailable(
      group,
      [...plannedImages.map((item) => item.filePath), ...allSidecarPaths],
      overwrite,
    );

    const files: OutputFile[] = [];
    const requestRecord = {
      ...params,
      prompt: args.prompt,
      input: path.basename(args.in),
      mask: args.mask ? path.basename(args.mask) : null,
      n,
    };
    const redactedResponse = nullBase64InResponse(providerResult.raw);

    await Promise.all(
      plannedImages.map((item) =>
        limit(async () => {
          await writeOutputBytes(item.filePath, item.data);
          const sha = hash(item.data);
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
