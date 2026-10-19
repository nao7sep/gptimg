// Exports and the upscaling model's download, run by the SDK in its utility
// process. An export is made in a private staging folder and then copied
// over the file the user chose, so a failed or cancelled export never leaves
// a half-written file where they asked for one. One task runs at a time.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GptImgErrorData, InspectResult, ModelListResult, RefusedResult } from "gptimgsdk/types";
import type { AppFailure, TaskProgress, UpscalerStatus } from "../shared/api.ts";
import { exportCall, type ExportRequest, type ImageInfo } from "../shared/export.ts";
import { failureFromError, failureFromRefusal, lostWorkerFailure } from "../shared/failures.ts";
import { message } from "../shared/i18n/translator.ts";
import { stagingName } from "./files.ts";
import type { Records } from "./records.ts";
import type { CallSettlement, SdkHost } from "./sdk-host.ts";

export const UPSCALER = "swin2sr";

export interface ExportDeps {
  host: SdkHost;
  records: Records;
  app: { name: string; version: string };
  stagingRoot: string;
  progress: (progress: TaskProgress) => void;
}

type Settled<T> = { ok: true; value: T } | { ok: false; failure: AppFailure; cancelled: boolean };

function settledFailure(settlement: CallSettlement): { failure: AppFailure; cancelled: boolean } | null {
  if (settlement.kind === "lost") return { failure: lostWorkerFailure(), cancelled: false };
  if (settlement.kind === "error") {
    const error = settlement.error as unknown as GptImgErrorData;
    return { failure: failureFromError(error), cancelled: error.code === "cancelled" };
  }
  const result = settlement.result as unknown as { status: string } & Partial<RefusedResult>;
  if (result.status === "refused" && result.refusal) return { failure: failureFromRefusal(result.refusal), cancelled: false };
  return null;
}

export class ExportRunner {
  readonly #deps: ExportDeps;
  #cancel: (() => void) | null = null;

  constructor(deps: ExportDeps) {
    this.#deps = deps;
  }

  get busy(): boolean {
    return this.#cancel !== null;
  }

  cancel(): void {
    this.#cancel?.();
  }

  async #run<T>(op: Parameters<SdkHost["call"]>[0], args: Record<string, unknown>, task: TaskProgress["task"] | null): Promise<Settled<T>> {
    const call = this.#deps.host.call(op, this.#deps.app, args, {
      onEvent: (event) => this.#deps.records.sdkEvent(null, event),
      onProgress: (p) => {
        if (!task) return;
        this.#deps.progress({
          task,
          stage: String(p.stage ?? ""),
          done: Number(p.done ?? 0),
          total: Number(p.total ?? 0),
          unit: String(p.unit ?? ""),
        });
      },
    });
    if (task) this.#cancel = call.cancel;
    try {
      const settlement = await call.done;
      const failed = settledFailure(settlement);
      if (failed) return { ok: false, ...failed };
      return { ok: true, value: (settlement as { result: unknown }).result as T };
    } finally {
      if (task) this.#cancel = null;
    }
  }

  async inspect(path: string): Promise<Settled<ImageInfo>> {
    const outcome = await this.#run<InspectResult>("inspect", { in: path }, null);
    if (!outcome.ok) return outcome;
    const r = outcome.value;
    return { ok: true, value: { width: r.width, height: r.height, format: r.format, fileBytes: r.fileBytes, transparent: !r.opaque } };
  }

  async upscalerStatus(): Promise<UpscalerStatus> {
    const outcome = await this.#run<ModelListResult>("modelList", {}, null);
    if (!outcome.ok) return { installed: false, downloadBytes: null };
    const entry = outcome.value.models.find((m) => m.key === UPSCALER);
    return { installed: entry?.cached ?? false, downloadBytes: entry?.downloadBytes ?? null };
  }

  async installUpscaler(): Promise<Settled<null>> {
    if (this.busy) return { ok: false, failure: { message: message("failure.taskRunning"), retryable: false }, cancelled: false };
    const outcome = await this.#run<unknown>("modelInstall", { key: UPSCALER }, "install");
    return outcome.ok ? { ok: true, value: null } : outcome;
  }

  /** Makes the export and puts it at `target`, which the user chose in the save dialog (and agreed to replace). */
  async export(request: ExportRequest, info: ImageInfo, target: string): Promise<Settled<string>> {
    if (this.busy) return { ok: false, failure: { message: message("failure.taskRunning"), retryable: false }, cancelled: false };
    const staging = join(this.#deps.stagingRoot, `export-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const { op, args } = exportCall(request, info, staging, "export");
      const outcome = await this.#run<{ output: string }>(op, args, "export");
      if (!outcome.ok) return outcome;
      // Staged beside the target and renamed over it, so the chosen file is replaced whole or not at all.
      const temp = stagingName(target);
      try {
        await copyFile(outcome.value.output, temp);
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        this.#deps.records.log("error", "export.writeFailed", { error: String(error) });
        return { ok: false, failure: { message: message("failure.exportFailed"), retryable: false }, cancelled: false };
      }
      this.#deps.records.log("info", "export.done", { op, format: request.format, size: request.size, target });
      return { ok: true, value: target };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function folderOf(path: string): string {
  return dirname(path);
}
