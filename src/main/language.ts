// Main owns the language (localization-stack-conventions, Electron): read the
// computer's languages once after ready and before any window, settle the
// saved choice, and hand the translator to every native surface.
import { readFileSync } from "node:fs";
import { app, systemPreferences } from "electron";
import { ENGLISH, loadCatalogue, type Catalogue } from "../shared/i18n/catalogues.ts";
import { formattingLocale, normalizePreference, resolveLanguage, type Language, type LanguagePreference } from "../shared/i18n/languages.ts";
import { createTranslator, type Translator } from "../shared/i18n/translator.ts";
import type { LanguageInfo } from "../shared/api.ts";
import type { Theme } from "../shared/settings.ts";
import { readHeader } from "./file-header.ts";
import type { ReadResult } from "./files.ts";
import { THEMES } from "../shared/settings.ts";

/** The saved language and theme, read straight from config.json without the store: any failure is System. */
export function earlyPreferences(configPath: string): { language: LanguagePreference; theme: Theme; read: ReadResult } {
  let read: ReadResult;
  try { read = { kind: "ok", text: readFileSync(configPath, "utf8") }; }
  catch (error) { read = (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "failed", error }; }
  try {
    const header = readHeader(JSON.parse(read.kind === "ok" ? read.text : "null"), "config");
    if (header.kind !== "ok") return { language: "system", theme: "system", read };
    const raw = header.body;
    const theme = typeof raw.theme === "string" && (THEMES as readonly string[]).includes(raw.theme) ? (raw.theme as Theme) : "system";
    return { language: normalizePreference(raw.language), theme, read };
  } catch {
    return { language: "system", theme: "system", read };
  }
}

/** Chromium's own strings follow an explicit choice; set before ready. */
export function chromiumLang(preference: LanguagePreference): string | null {
  if (preference === "system") return null;
  return preference === "zh-Hans" ? "zh-CN" : preference;
}

const APPLE_LANGUAGES = "AppleLanguages";

function writesAppleLanguages(): boolean {
  return process.platform === "darwin" && app.isPackaged;
}

/** Removes the app's own AppleLanguages entry, which would otherwise shadow the computer's list. */
export function clearAppleLanguages(log: (error: unknown) => void): void {
  if (!writesAppleLanguages()) return;
  try {
    systemPreferences.removeUserDefault(APPLE_LANGUAGES);
  } catch (error) {
    log(error);
  }
}

/** Keeps the interface language in the app's own defaults domain, so macOS's own menu items follow at next launch. */
export function writeAppleLanguages(preference: LanguagePreference, log: (error: unknown) => void): void {
  if (!writesAppleLanguages()) return;
  try {
    if (preference === "system") systemPreferences.removeUserDefault(APPLE_LANGUAGES);
    else systemPreferences.setUserDefault(APPLE_LANGUAGES, "array", [preference]);
  } catch (error) {
    log(error);
  }
}

export class LanguageOwner {
  #computer: string[] = [];
  #systemLocale = "en";
  #translator!: Translator;
  #catalogue: Catalogue = ENGLISH;
  #preference: LanguagePreference = "system";
  readonly #listeners = new Set<(info: LanguageInfo) => void>();

  /** Reads the computer once; call after ready, after clearing the app's own AppleLanguages entry. */
  readComputer(): void {
    this.#computer = app.getPreferredSystemLanguages();
    this.#systemLocale = app.getSystemLocale() || "en";
  }

  get translator(): Translator {
    return this.#translator;
  }

  get systemLanguage(): Language {
    return resolveLanguage("system", this.#computer);
  }

  info(): LanguageInfo {
    return { language: this.#translator.language, locale: this.#translator.locale, systemLanguage: this.systemLanguage, catalogue: this.#catalogue };
  }

  /** Settles a preference; returns true when the language or its locale moved. */
  async use(preference: LanguagePreference): Promise<boolean> {
    this.#preference = preference;
    const language = resolveLanguage(preference, this.#computer);
    const locale = formattingLocale(language, this.#systemLocale);
    if (this.#translator && this.#translator.language === language && this.#translator.locale === locale) return false;
    this.#catalogue = await loadCatalogue(language);
    this.#translator = createTranslator(language, locale, this.#catalogue, ENGLISH);
    for (const listener of this.#listeners) listener(this.info());
    return true;
  }

  get preference(): LanguagePreference {
    return this.#preference;
  }

  onChange(listener: (info: LanguageInfo) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
