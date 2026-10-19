import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { api } from "./api.ts";
import { I18nProvider } from "./i18n.tsx";
import "./styles/tokens.css";
import "./styles/app.css";

const root = createRoot(document.getElementById("root")!);

void api.boot().then((boot) => {
  root.render(
    <StrictMode>
      <I18nProvider initial={boot.language}>
        <App boot={boot} />
      </I18nProvider>
    </StrictMode>,
  );
});
