import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { RecordsWindow } from "./records/RecordsWindow.tsx";
import { StartupFailureView } from "./StartupFailure.tsx";
import { api } from "./api.ts";
import { I18nProvider } from "./i18n.tsx";
import "./styles/tokens.css";
import "./styles/app.css";

const root = createRoot(document.getElementById("root")!);

if (window.location.hash === "#startup") {
  void api.startupFailure().then((failure) => {
    root.render(
      <StrictMode>
        <I18nProvider initial={failure.language}>
          <StartupFailureView failure={failure} />
        </I18nProvider>
      </StrictMode>,
    );
  });
} else void api.boot().then((boot) => {
  root.render(
    <StrictMode>
      <I18nProvider initial={boot.language}>
        {window.location.hash === "#records" ? <RecordsWindow boot={boot} /> : <App boot={boot} />}
      </I18nProvider>
    </StrictMode>,
  );
});
