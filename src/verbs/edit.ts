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
  createOutputGroup,
  sidecarPath as outputGroupSidecarPath,
} from "../internal/output-group.js";
import { createLogger, safeLogError } from "../log/index.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadProfile } from "../profile/load.js";
import { resolveProfile } from "../profile/resolve.js";
import { applyPatch } from "../recipe/applyPatch.js";
import { applySet } from "../recipe/applySet.js";
import { loadRecipe } from "../recipe/load.js";
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
import {
  defaultLogPath,
  defaultOutDir,
  defaultProfilePath,
  defaultRecipePath,
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
  const ts = utcTimestamp();
  const profilePath = args.profile ?? defaultProfilePath(ctx.profileDir);
  const recipePath = args.recipe ?? defaultRecipePath(ctx.profileDir);
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const logger = await createLogger(logPath, "edit");
  const signal = opts.signal;

  try {
    const profile = await loadProfile(profilePath);
    const resolved = resolveProfile(profile);
    await logger.info("resolve", "apiKey resolved", {
      apiKeySource: resolved.apiKeySource,
      provider: profile.provider,
    });

    let recipe = await loadRecipe(recipePath);
    if (args.patch) recipe = applyPatch(recipe, args.patch);
    if (args.set?.length) recipe = await applySet(recipe, "edit", args.set);
    const network = await resolveNetworkForCall(profile, recipe, logger);
    const section = validateEditSection(recipe.edit);
    const params: Record<string, unknown> = { ...section };

    const n =
      typeof params.n === "number" && (params.n as number) > 0
        ? (params.n as number)
        : 1;

    await assertReadableImage(args.in, "input");
    if (args.mask) await assertReadableImage(args.mask, "mask");

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

    const outDir = args.outDir ?? defaultOutDir(ctx.profileDir);
    await ensureOutputDir(outDir);
    const stem = args.outName ?? defaultStem(ts);
    const overwrite = args.overwrite ?? false;
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

    const stemPath = path.join(outDir, stem);
    const imageExts = new Set(plannedImages.map((item) => item.fmt.extension));
    if (imageExts.size > 1) {
      throw new LocalOpError(
        "output.mixedExtensions",
        `Provider returned images with mixed extensions (${[...imageExts].join(", ")}); the artifact group requires a single image format.`,
      );
    }
    const groupExt = plannedImages[0]?.fmt.extension ?? "png";
    const group = createOutputGroup(outDir, stem, groupExt);
    const sidecarPath = outputGroupSidecarPath(group);
    assertOutputGroupAvailable(
      group,
      [...plannedImages.map((item) => item.filePath), sidecarPath],
      overwrite,
    );

    const files: OutputFile[] = [];

    await Promise.all(
      plannedImages.map((item) =>
        limit(async () => {
          await writeOutputBytes(item.filePath, item.data);
          const sha = hash(item.data);
          files.push({
            index: item.index,
            path: item.filePath,
            sha256: sha,
            format: item.fmt.format,
          });
          await logger.info("write", `wrote image ${item.index}`, {
            index: item.index,
            name: item.fileName,
            sha256: sha,
            format: item.fmt.format,
          });
        }),
      ),
    );
    files.sort((a, b) => a.index - b.index);

    const sidecar: Sidecar = {
      request: {
        ...params,
        prompt: args.prompt,
        input: path.basename(args.in),
        mask: args.mask ? path.basename(args.mask) : null,
        n,
      },
      response: nullBase64InResponse(providerResult.raw),
      files: files.map((f) => ({
        index: f.index,
        name: path.basename(f.path),
        sha256: f.sha256,
        format: f.format,
      })),
    };
    await writeSidecar(stemPath, sidecar);
    await logger.info("write", "wrote sidecar", {
      name: path.basename(sidecarPath),
    });

    return {
      files,
      sidecarPath,
      logPath: logger.handle.path,
      partial,
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
