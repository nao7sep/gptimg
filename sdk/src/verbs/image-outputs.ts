import path from "node:path";
import pLimit from "p-limit";
import { GptImgError } from "../errors.ts";
import { detectFormat } from "../image/detectFormat.ts";
import { hash } from "../image/hash.ts";
import { writeOutputBytes } from "../internal/output-files.ts";
import {
  assertOutputGroupAvailable,
  createOutputGroup,
  ownedSlotFiles,
  removeUnpublishedSlots,
  sidecarPathFor,
} from "../internal/output-group.ts";
import type { Logger } from "../log/index.ts";
import { maskDiagnosticCopy } from "../log/mask.ts";
import type { ProviderImageResult } from "../providers/types.ts";
import { RefusalSignal } from "../refusal.ts";
import { nullBase64InResponse } from "../sidecar/nullBase64.ts";
import { writeSidecar } from "../sidecar/write.ts";
import type {
  ChatRequestRecord,
  ChatSidecar,
  EditRequestRecord,
  EditSidecar,
  FilePublication,
  GenerateRequestRecord,
  GenerateSidecar,
  ItemFailure,
  OutputFile,
  SidecarWriter,
} from "../types.ts";
import { planGenerateOutputs, type DetectedImage } from "./generate-plan.ts";

export interface PublishProviderImagesArgs {
  kind: "generate" | "edit" | "chat";
  outDir: string;
  stem: string;
  /** The image count the run requested, which its pre-call check reserved. */
  n: number;
  overwrite: boolean;
  providerResult: ProviderImageResult;
  /** What each per-image sidecar records as the request. */
  requestRecord: GenerateRequestRecord | EditRequestRecord | ChatRequestRecord;
  writer: SidecarWriter;
  /** Known credentials, applied only to sidecar snapshots. */
  credentials?: readonly string[];
  logger: Logger;
}

export interface PublishedImages {
  files: OutputFile[];
  failures: ItemFailure[];
  leftovers: string[];
  /** The paid response as each record holds it, for the result whether or not any image published. */
  response: Record<string, unknown>;
}

/** An item failure from whatever a step threw, after the paid response arrived. */
function itemFailure(index: number, err: unknown): ItemFailure {
  if (err instanceof RefusalSignal) {
    return { index, code: err.refusal.code, effect: "unknown", message: err.refusal.message };
  }
  if (err instanceof GptImgError) return { index, code: err.code, effect: "unknown", message: err.message };
  return { index, code: "internal.unexpected", effect: "unknown", message: (err as Error)?.message ?? String(err) };
}

function failedPublication(err: unknown): FilePublication {
  const f = itemFailure(0, err);
  return { status: "failed", code: f.code as Exclude<ItemFailure["code"], "provider.noImage">, effect: f.effect, message: f.message };
}

/**
 * Publish a paid image response as one artifact group: every image that
 * decoded, each with its own sidecar, reported item by item.
 *
 * The response has been paid for, so nothing here throws for the run: an item
 * that yielded no image, or whose image could not be published, is an item
 * failure with its own code and `effect: "unknown"`, and the other items still
 * publish. Each image publishes first and its sidecar second; when the sidecar
 * fails the image is kept and its `sidecar` field says so, with the record
 * still in the result (sdk-conventions, *An artifact holds itself*).
 *
 * The run owns the slots it reserved before the provider call and the slots
 * the response names, and its overwrite decision covers all of them. With
 * `overwrite`, a slot the run owned but could not fill is cleared after
 * publication; files it could not clear are returned as `leftovers`. A run
 * that publishes no image leaves the earlier run's files untouched.
 */
export async function publishProviderImages(args: PublishProviderImagesArgs): Promise<PublishedImages> {
  const { outDir, stem, n, overwrite, providerResult, requestRecord, logger } = args;
  const items = providerResult.images;
  const limit = pLimit(4);
  const failures: ItemFailure[] = [];
  const snapshot = maskDiagnosticCopy(
    { request: requestRecord, response: nullBase64InResponse(providerResult.raw) },
    args.credentials ?? [],
  ) as { request: GenerateRequestRecord | EditRequestRecord | ChatRequestRecord; response: Record<string, unknown> };

  // A requested image the provider did not return at all is an item failure too,
  // so a short or empty response is reported rather than silently yielding fewer files.
  for (let index = items.length + 1; index <= n; index++) {
    failures.push({ index, code: "provider.noImage", effect: "unknown", message: `The provider returned ${items.length} of the ${n} images requested.` });
  }
  if (items.length < n) await logger.warn("response", "the provider returned fewer images than requested", { requested: n, returned: items.length });

  // Detect each returned image's format (the I/O step). A null format marks a
  // failed item: no data, or bytes that would not decode.
  const detected = await Promise.all(
    items.map((item, i) =>
      limit(async (): Promise<{ data: Uint8Array | null } & DetectedImage> => {
        const index = i + 1;
        if (!item.data) {
          failures.push({ index, code: "provider.noImage", effect: "unknown", message: item.error ?? `The provider returned no image for item ${index}.` });
          await logger.warn("write", `image ${index} failed`, { index, error: item.error ?? null });
          return { data: null, format: null };
        }
        try {
          return { data: item.data, format: await detectFormat(item.data) };
        } catch (err) {
          failures.push({ index, code: "image.undecodable", effect: "unknown", message: (err as Error).message });
          await logger.warn("write", `image ${index} format detection failed`, { index, error: (err as Error).message });
          return { data: item.data, format: null };
        }
      }),
    ),
  );

  const plan = planGenerateOutputs(n, stem, detected);
  const { suffixCount } = plan;
  const planned = plan.images.map((img) => ({
    index: img.index,
    data: detected[img.index - 1]!.data!,
    fmt: img.format,
    filePath: path.join(outDir, img.fileName),
  }));

  const group = createOutputGroup(outDir, stem, plan.groupExtension);
  const owned = ownedSlotFiles(group, n, items.length);
  try {
    assertOutputGroupAvailable(group, owned, overwrite);
  } catch (err) {
    // A conflict that appeared during the paid call fails every planned item;
    // nothing was written.
    for (const item of planned) failures.push(itemFailure(item.index, err));
    failures.sort((a, b) => a.index - b.index);
    return { files: [], failures, leftovers: [], response: snapshot.response };
  }

  const files: OutputFile[] = [];

  await Promise.all(
    planned.map((item) =>
      limit(async () => {
        try {
          await writeOutputBytes(item.filePath, item.data, overwrite);
        } catch (err) {
          failures.push(itemFailure(item.index, err));
          await logger.warn("write", `image ${item.index} could not be published`, { index: item.index, error: (err as Error).message });
          return;
        }
        const sha256 = hash(item.data);
        const sidecarPath = sidecarPathFor(group, item.index, suffixCount);
        // Per-image record: the same request and response across siblings, but
        // `files` carries only this image's entry, so each sidecar describes
        // its own image.
        const record = {
          formatVersion: 2,
          kind: args.kind,
          writer: args.writer,
          request: snapshot.request,
          response: snapshot.response,
          files: [{ index: item.index, name: path.basename(item.filePath), sha256, format: item.fmt.format }],
        } as GenerateSidecar | EditSidecar | ChatSidecar;
        let sidecar: FilePublication = { status: "published" };
        try {
          await writeSidecar(sidecarPath, record, { overwrite });
        } catch (err) {
          sidecar = failedPublication(err);
          await logger.warn("write", `sidecar for image ${item.index} could not be published; the image is kept`, {
            index: item.index,
            sidecar: path.basename(sidecarPath),
            error: (err as Error).message,
          });
        }
        files.push({ index: item.index, path: item.filePath, sha256, format: item.fmt.format, sidecarPath, sidecar, record });
        await logger.info("write", `wrote image ${item.index}`, {
          index: item.index,
          name: path.basename(item.filePath),
          sha256,
          format: item.fmt.format,
          sidecar: sidecar.status === "published" ? path.basename(sidecarPath) : null,
        });
      }),
    ),
  );

  // A run that published nothing leaves the earlier run's files as they are:
  // a paid call that produced no image must not destroy previous results.
  let leftovers: string[] = [];
  if (overwrite && files.length > 0) {
    leftovers = await removeUnpublishedSlots(
      group,
      owned,
      files.flatMap((file) => (file.sidecar.status === "published" ? [file.path, file.sidecarPath] : [file.path])),
    );
    if (leftovers.length > 0) {
      await logger.warn("write", "could not remove files an earlier run left in this run's slots", { leftovers });
    }
  }
  files.sort((a, b) => a.index - b.index);
  failures.sort((a, b) => a.index - b.index);
  return { files, failures, leftovers, response: snapshot.response };
}
