// The export and the upscaler download as the window's own state, not the Export
// dialog's: the main process runs them, and closing the dialog never stops one
// (modal-dialog-conventions, *Busy and Non-Interruptible States*). While one runs,
// its progress shows in the dialog when it is open and in the task strip when it is
// not, and Stop is the only way to cancel it. A download is its own action: no
// export waits on it, so a finished download creates nothing; the export button
// becomes available the next time the dialog is used.
import { useCallback, useEffect, useState } from "react";
import type { AppFailure, TaskProgress } from "../../shared/api.ts";
import type { ExportRequest } from "../../shared/export.ts";
import { api } from "./api.ts";

export type ExportTaskKind = "install" | "export";

export interface RunningTask {
  kind: ExportTaskKind;
  /** An export that upscales, which reads as such while it runs. */
  upscaling: boolean;
}

/** How the last task ended, until a new one starts or the user dismisses it. */
export interface TaskOutcome {
  kind: ExportTaskKind;
  failure: AppFailure | null;
  /** Ended by Stop: nothing to report. */
  stopped: boolean;
  /** Seen in the dialog, or dismissed in the strip. */
  seen: boolean;
}

export interface ExportTasks {
  task: RunningTask | null;
  progress: TaskProgress | null;
  outcome: TaskOutcome | null;
  download: () => Promise<void>;
  exportImage: (request: ExportRequest, suggestedName: string, upscaling: boolean, onSaved: (savedTo: string, dir: string | null) => void) => Promise<void>;
  stop: () => void;
  markSeen: () => void;
}

const stoppedBy = (failure: AppFailure) => failure.message.key === "failure.cancelled";

export function useExportTasks(): ExportTasks {
  const [task, setTask] = useState<RunningTask | null>(null);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [outcome, setOutcome] = useState<TaskOutcome | null>(null);

  useEffect(() => api.onProgress(setProgress), []);

  const begin = (next: RunningTask) => {
    setTask(next);
    setProgress(null);
    setOutcome(null);
  };
  const end = (kind: ExportTaskKind, failure: AppFailure | null) => {
    setTask(null);
    setProgress(null);
    setOutcome({ kind, failure, stopped: failure !== null && stoppedBy(failure), seen: false });
  };

  const download = useCallback(async () => {
    begin({ kind: "install", upscaling: false });
    const result = await api.installUpscaler();
    end("install", result.ok ? null : result.failure);
  }, []);

  const exportImage = useCallback<ExportTasks["exportImage"]>(async (request, suggestedName, upscaling, onSaved) => {
    begin({ kind: "export", upscaling });
    const result = await api.exportImage(request, suggestedName);
    if (result.ok && !result.savedTo) {
      // The save dialog was dismissed: nothing ran, nothing to report.
      setTask(null);
      return;
    }
    end("export", result.ok ? null : result.failure);
    if (result.ok && result.savedTo) onSaved(result.savedTo, result.dir);
  }, []);

  const stop = useCallback(() => api.cancelTask(), []);
  const markSeen = useCallback(() => setOutcome((o) => (o && !o.seen ? { ...o, seen: true } : o)), []);

  return { task, progress, outcome, download, exportImage, stop, markSeen };
}
