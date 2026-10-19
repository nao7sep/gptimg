// GptImg could not start: what happened in the app's own words, the system's
// words beneath under Details, and Close. Nothing was written.
import type { StartupFailure } from "../../shared/api.ts";
import { api } from "./api.ts";
import { useI18n } from "./i18n.tsx";

export function StartupFailureView({ failure }: { failure: StartupFailure }) {
  const { t, of } = useI18n();
  return (
    <div className="startup-failure">
      <h1>{t("startup.title")}</h1>
      <p>{of(failure.message)}</p>
      <details>
        <summary>{t("startup.details")}</summary>
        <pre>{failure.detail}</pre>
      </details>
      <div className="startup-actions">
        <button type="button" className="button primary" autoFocus onClick={() => api.quitApp()}>
          {t("startup.close")}
        </button>
      </div>
    </div>
  );
}
