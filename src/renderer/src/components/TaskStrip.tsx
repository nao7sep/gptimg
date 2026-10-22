// The export or upscaler download while the Export dialog is closed: what is
// running, with Stop, and how it ended until the user dismisses it. A stopped
// task leaves nothing to report.
import type { ExportTasks } from "../export-tasks.ts";
import { useI18n } from "../i18n.tsx";
import { CloseIcon } from "./icons.tsx";

export function TaskStrip({ tasks }: { tasks: ExportTasks }) {
  const { t, of } = useI18n();
  const { task, progress, outcome } = tasks;
  const progressText = progress && progress.total > 0 ? t("export.progress", { done: progress.done, total: progress.total }) : null;

  if (task) {
    return (
      <div className="task-strip" role="status">
        <span className="task-strip-text">
          {t(task.kind === "export" ? (task.upscaling ? "export.strip.upscaling" : "export.strip.exporting") : "export.strip.downloading")}
          {progressText && ` ${progressText}`}
        </span>
        <button type="button" className="button" onClick={tasks.stop}>
          {t("export.stop")}
        </button>
      </div>
    );
  }
  if (!outcome || outcome.seen || outcome.stopped) return null;
  const failed = outcome.failure !== null;
  return (
    <div className={`task-strip${failed ? " failed" : ""}`} role={failed ? "alert" : "status"}>
      <span className="task-strip-text">
        {outcome.failure ? of(outcome.failure.message) : t(outcome.kind === "install" ? "export.strip.downloaded" : "export.strip.exported")}
      </span>
      <button type="button" className="icon-button" onClick={tasks.markSeen} aria-label={t("common.dismiss")} title={t("common.dismiss")}>
        <CloseIcon size={15} />
      </button>
    </div>
  );
}
