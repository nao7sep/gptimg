import path from "node:path";
import pLimit from "p-limit";
import { LocalOpError } from "../errors.js";
import { detectFormat } from "../image/detectFormat.js";
import { hash } from "../image/hash.js";
import { writeOutputBytes } from "../internal/output-files.js";
import {
  assertOutputGroupAvailable,
  createOutputGroup,
  ownedSlotFiles,
  removeUnpublishedSlots,
  settleOutputPublications,
  sidecarPathFor,
} from "../internal/output-group.js";
import type { Logger } from "../log/index.js";
import type { ProviderImageResult } from "../providers/types.js";
import { nullBase64InResponse } from "../sidecar/nullBase64.js";
import { writeSidecar } from "../sidecar/write.js";
import type { OutputFile, Sidecar } from "../types.js";
import { planGenerateOutputs, type DetectedImage } from "./generate-plan.js";

export interface PublishProviderImagesArgs {
  outDir: string;
  stem: string;
  /** The image count the run requested, which its pre-call check reserved. */
  n: number;
  overwrite: boolean;
  providerResult: ProviderImageResult;
  /** What each per-image sidecar records as the request. */
  requestRecord: Record<string, unknown>;
  logger: Logger;
}

/**
 * Publish a paid image response as one artifact group: every image that
 * decoded, each with its own sidecar.
 *
 * The run owns the slots it reserved before the provider call and the slots
 * the response names, and its overwrite decision covers all of them. With
 * `overwrite`, a slot the run owned but could not fill (an item that failed,
 * or a shorter response) is cleared after publication rather than blocking
 * it, so the group ends up holding exactly this run's files and a partial
 * response still delivers every image it paid for.
 */
export async function publishProviderImages(
  args: PublishProviderImagesArgs,
): Promise<{ files: OutputFile[]; partial: boolean }> {
  const { outDir, stem, n, overwrite, providerResult, requestRecord, logger } = args;
  const items = providerResult.images;
  const limit = pLimit(4);

  // Detect each returned image's format (the I/O step). A null format marks a
  // failed item — no data, or bytes that would not decode — which the planner
  // drops from the outputs and counts toward `partial`.
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
  // The planner includes an image only because its format detected, which
  // implies its data was present; the guard makes that invariant explicit.
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
  const owned = ownedSlotFiles(group, n, items.length);
  const redactedResponse = nullBase64InResponse(providerResult.raw);
  const files: OutputFile[] = [];

  assertOutputGroupAvailable(group, owned, overwrite);
  await settleOutputPublications(
    plannedImages.map(
      (item) => () =>
        limit(async () => {
          await writeOutputBytes(item.filePath, item.data, overwrite);
          const sha = hash(item.data);
          // Per-image sidecar: the same request and response across siblings,
          // but `files` carries only this image's entry so each sidecar is
          // self-describing.
          const itemSidecarPath = sidecarPathFor(group, item.index, suffixCount);
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
          await writeSidecar(itemSidecarPath.replace(/\.json$/, ""), itemSidecar, { overwrite });
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
  if (overwrite) {
    await removeUnpublishedSlots(
      group,
      owned,
      files.flatMap((file) => [file.path, file.sidecarPath]),
    );
  }
  files.sort((a, b) => a.index - b.index);
  return { files, partial };
}
