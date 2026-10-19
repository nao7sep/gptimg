// The language main settled, as a React context. The provider renders nothing
// until it has a translator, so the first text on screen is already in it.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LanguageInfo } from "../../shared/api.ts";
import { ENGLISH } from "../../shared/i18n/catalogues.ts";
import { createTranslator, type Translator } from "../../shared/i18n/translator.ts";
import { api } from "./api.ts";

interface I18n {
  t: Translator["t"];
  of: Translator["of"];
  translator: Translator;
  info: LanguageInfo;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ initial, children }: { initial: LanguageInfo; children: ReactNode }) {
  const [info, setInfo] = useState(initial);
  useEffect(() => api.onLanguage(setInfo), []);
  const value = useMemo(() => {
    const translator = createTranslator(info.language, info.locale, info.catalogue, ENGLISH);
    return { t: translator.t, of: translator.of, translator, info };
  }, [info]);
  useEffect(() => {
    document.documentElement.lang = info.language;
  }, [info.language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}

/** For the last-resort error surface outside the provider: English, which is always loaded. */
export function documentTranslator(): Translator {
  return createTranslator("en", "en", ENGLISH, ENGLISH);
}
