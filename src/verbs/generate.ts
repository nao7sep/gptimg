import path from "node:path";
import pLimit from "p-limit";
import { LocalOpError } from "../errors.js";
import { hash } from "../image/hash.js";
import { detectFormat } from "../image/detectFormat.js";
import { planGenerateOutputs, type DetectedImage } from "./generate-plan.js";
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
import { multiline } from "../internal/textCleanup.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadProfile } from "../profile/load.js";
import { resolveProfile } from "../profile/resolve.js";
import { mergeRecipes } from "../recipe/merge.js";
import { loadRecipeForCall } from "../recipe/load.js";
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
  defaultStem,
  utcTimestamp,
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
  const ts = utcTimestamp();
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

    const items = providerResult.images;
    const limit = pLimit(4);

    // Detect each returned image's format (the I/O step). A null format marks a
    // failed item — no data, or bytes that would not decode — which the planner
    // drops from the outputs and counts toward `partial`. `data` is kept so the
    // bytes can be reattached to the plan below.
    const detected = await Promise.all(
      items.map((item, i) =>
        limit(async (): Promise<{ data: Uint8Array | null } & DetectedImage> => {
          const index = i + 1;
          if (!item.data) {
            await logger.warn("write", `image ${index} failed`, {
              index,
              error: item.error ?? null,
            });
            return { data: null, format: null };
          }
          try {
            return { data: item.data, format: await detectFormat(item.data) };
          } catch (err) {
            await logger.warn("write", `image ${index} format detection failed`, {
              index,
              error: (err as Error).message,
            });
            return { data: item.data, format: null };
          }
        }),
      ),
    );

    const plan = planGenerateOutputs(n, stem, detected);
    const { suffixCount, partial } = plan;
    // Reattach each planned image's bytes by its (stable, 1-based) provenance
    // index. The planner included an image only because its format detected, and
    // a non-null format implies the data was present, so the slot is guaranteed
    // to carry bytes; the guard makes that invariant explicit.
    const plannedImages = plan.images.map((img) => {
      const data = detected[img.index - 1]?.data;
      if (!data) {
        throw new LocalOpError("output.internal", `planned image ${img.index} lost its data`);
      }
      return {
        index: img.index,
        data,
        fmt: img.format,
        fileName: img.fileName,
        filePath: path.join(outDir, img.fileName),
      };
    });

    const group = createOutputGroup(outDir, stem, plan.groupExtension);
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
      prompt,
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
