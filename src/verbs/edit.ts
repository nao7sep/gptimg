import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import pLimit from "p-limit";
import { Buffer } from "node:buffer";
import { LocalOpError } from "../errors.js";
import { hash } from "../image/hash.js";
import { detectFormat } from "../image/detectFormat.js";
import { createLogger } from "../log/index.js";
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

export async function editImpl(
  ctx: EditContext,
  args: EditArgs,
): Promise<EditResult> {
  const ts = utcTimestamp();
  const profilePath = args.profile ?? defaultProfilePath(ctx.profileDir);
  const recipePath = args.recipe ?? defaultRecipePath(ctx.profileDir);
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const logger = await createLogger(logPath, "edit");

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
    const section = validateEditSection(recipe.edit);
    const params: Record<string, unknown> = { ...section };

    const n =
      typeof params.n === "number" && (params.n as number) > 0
        ? (params.n as number)
        : 1;

    await logger.info("request", "calling provider.edit", {
      provider: profile.provider,
      model: params.model ?? profile.model ?? null,
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
    });
    await logger.info("response", "provider.edit returned", {
      itemCount: providerResult.images.length,
    });

    const outDir = args.outDir ?? defaultOutDir(ctx.profileDir);
    await mkdir(outDir, { recursive: true });
    const stem = args.outName ?? defaultStem(ts);
    const overwrite = args.overwrite ?? false;
    const limit = pLimit(4);
    const files: OutputFile[] = [];
    let partial = false;

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
            return;
          }
          let fmt;
          try {
            fmt = await detectFormat(item.data);
          } catch (err) {
            partial = true;
            await logger.warn("write", `image ${index} format detection failed`, {
              index,
              error: (err as Error).message,
            });
            return;
          }
          const fileName = imageFileName(stem, index, n, fmt.extension);
          const filePath = path.join(outDir, fileName);
          if (!overwrite && existsSync(filePath)) {
            throw new LocalOpError(
              "output.exists",
              `Output exists: ${filePath}. Use overwrite to allow.`,
            );
          }
          await writeFileAtomic(filePath, Buffer.from(item.data));
          const sha = hash(item.data);
          files.push({ index, path: filePath, sha256: sha, format: fmt.format });
          await logger.info("write", `wrote image ${index}`, {
            index,
            name: fileName,
            sha256: sha,
            format: fmt.format,
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
    const stemPath = path.join(outDir, stem);
    const sidecarPath = await writeSidecar(stemPath, sidecar);
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
    await logger.error("error", (err as Error).message, {
      code: (err as { code?: string }).code ?? null,
    });
    throw err;
  } finally {
    await logger.close();
  }
}
