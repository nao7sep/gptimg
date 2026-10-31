// GptImg could not start: what happened in the app's own words, each refused
// file named with why and what the user can do, the system's words beneath
// under Details, and Close. Nothing was written.
import type { StartupFailure } from "../../shared/api.ts";
import { api } from "./api.ts";
import { useI18n } from "./i18n.tsx";

export function StartupFailureView({ failure }: { failure: StartupFailure }) {
  const { t, of } = useI18n();
  return (
    <div className="startup-failure">
      <h1>{t("startup.title")}</h1>
      <p>{of(failure.message)}</p>
      {failure.refused.length > 0 && (
        <>
          <ul className="startup-refused">
            {failure.refused.map((file) => (
              <li key={file.path}>{t(file.reason === "newer" ? "startup.refusedNewer" : "startup.refusedUnreadable", { path: file.path })}</li>
            ))}
          </ul>
          <p>{t("startup.refusedAdvice")}</p>
        </>
      )}
      {failure.detail && (
        <details>
          <summary>{t("startup.details")}</summary>
          <pre>{failure.detail}</pre>
        </details>
      )}
      <div className="startup-actions">
        <button type="button" className="button primary" autoFocus onClick={() => api.quitApp()}>
          {t("startup.close")}
        </button>
      </div>
    </div>
  );
}
