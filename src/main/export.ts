// Exports and the upscaling model's download, run by the SDK. The SDK writes an
// export at the file the user chose, whole or not at all. One task runs at a time.
import { dirname } from "node:path";
import type { GptImg, VerbCallOptions } from "gptimgsdk";
import type { RefusedResult } from "gptimgsdk/types";
import type { AppFailure, TaskProgress, UpscalerStatus } from "../shared/api.ts";
import { exportCall, exportTarget, type ExportRequest, type ImageInfo } from "../shared/export.ts";
import { failureFromError, failureFromRefusal } from "../shared/failures.ts";
import { message } from "../shared/i18n/translator.ts";
import type { Records } from "./records.ts";
import { errorData } from "./sdk.ts";

export const UPSCALER = "swin2sr";

export interface ExportDeps {
  sdk: Pick<GptImg, "inspect" | "encode" | "resize" | "upscale" | "model">;
  records: Records;
  progress: (progress: TaskProgress) => void;
}

type Settled<T> = { ok: true; value: T } | { ok: false; failure: AppFailure; cancelled: boolean };


export class ExportRunner {
  readonly #deps: ExportDeps;
  #cancel: (() => void) | null = null;
  #task: Promise<unknown> | null = null;

  constructor(deps: ExportDeps) {
    this.#deps = deps;
  }

  get busy(): boolean {
    return this.#task !== null;
  }

  /** Cancels the running task; settles once it has ended. */
  cancel(): Promise<void> {
    this.#cancel?.();
    return Promise.resolve(this.#task).then(() => undefined);
  }

  /** The one task: an export (with its model release) or the upscaler's download. */
  #exclusive<T>(work: () => Promise<Settled<T>>): Promise<Settled<T>> {
    if (this.#task) return Promise.resolve({ ok: false, failure: { message: message("failure.taskRunning"), retryable: false }, cancelled: false });
    const task = work().finally(() => { this.#task = null; });
    this.#task = task;
    return task;
  }

  async #run<T>(work: (options: VerbCallOptions) => Promise<T | RefusedResult>, task: TaskProgress["task"] | null): Promise<Settled<T>> {
    const controller = new AbortController();
    if (task) this.#cancel = () => controller.abort();
    try {
      const result = await work({
        signal: controller.signal,
        onEvent: (event) => this.#deps.records.sdkEvent(null, event as unknown as Record<string, unknown>),
        ...(task && { onProgress: (p) => this.#deps.progress({ task, stage: p.stage, done: p.done, total: p.total, unit: p.unit }) }),
      });
      const refused = result as Partial<RefusedResult>;
      if (refused.status === "refused" && refused.refusal) return { ok: false, failure: failureFromRefusal(refused.refusal), cancelled: false };
      return { ok: true, value: result as T };
    } catch (thrown) {
      const error = errorData(thrown);
      return { ok: false, failure: failureFromError(error), cancelled: error.code === "cancelled" };
    } finally {
      if (task) this.#cancel = null;
    }
  }

  async #release(): Promise<void> {
    // The export already succeeded or failed on its own; a model that will not unload is only recorded.
    const outcome = await this.#run((o) => this.#deps.sdk.model.release({}, o), null);
    if (!outcome.ok) this.#deps.records.log("warn", "model.releaseFailed", { failure: outcome.failure });
    else if (outcome.value.released > 0) this.#deps.records.log("info", "model.released", { released: outcome.value.released });
  }

  async inspect(path: string): Promise<Settled<ImageInfo>> {
    const outcome = await this.#run((o) => this.#deps.sdk.inspect({ in: path }, o), null);
    if (!outcome.ok) return outcome;
    const r = outcome.value;
    return { ok: true, value: { width: r.width, height: r.height, format: r.format, fileBytes: r.fileBytes, transparent: !r.opaque } };
  }

  async upscalerStatus(): Promise<UpscalerStatus> {
    const outcome = await this.#run((o) => this.#deps.sdk.model.list({}, o), null);
    if (!outcome.ok) return { installed: false, downloadBytes: null, failure: outcome.failure };
    const entry = outcome.value.models.find((m) => m.key === UPSCALER);
    return { installed: entry?.cached ?? false, downloadBytes: entry?.downloadBytes ?? null };
  }

  installUpscaler(): Promise<Settled<null>> {
    return this.#exclusive(async () => {
      const outcome = await this.#run((o) => this.#deps.sdk.model.install({ key: UPSCALER }, o), "install");
      this.#deps.records.log(outcome.ok ? "info" : "warn", outcome.ok ? "model.installed" : "model.installFailed", { key: UPSCALER });
      return outcome.ok ? { ok: true, value: null } : outcome;
    });
  }

  /**
   * Makes the export at `chosen`, which the user picked in the save dialog (and agreed to
   * replace). The SDK writes it there whole or not at all, so a failed or cancelled export never
   * leaves a half-written file where they asked for one.
   */
  export(request: ExportRequest, info: ImageInfo, chosen: string): Promise<Settled<string>> {
    return this.#exclusive(async () => {
      const target = exportTarget(chosen, request.format);
      try {
        const { op, args } = exportCall(request, info, target);
        const outcome = await this.#run((o) => this.#deps.sdk[op](args as never, o) as Promise<{ output: string } | RefusedResult>, "export");
        if (!outcome.ok) {
          if (!outcome.cancelled) this.#deps.records.log("warn", "export.failed", { op, format: request.format, size: request.size });
          return outcome;
        }
        this.#deps.records.log("info", "export.done", { op, format: request.format, size: request.size, target: outcome.value.output });
        return { ok: true, value: outcome.value.output };
      } finally {
        // A loaded upscaler holds gigabytes; give them back once the export is done, however it ended.
        if (request.size.kind === "upscale") await this.#release();
      }
    });
  }
}

export function folderOf(path: string): string {
  return dirname(path);
}
