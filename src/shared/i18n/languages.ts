// The interface languages, each named in itself so the picker loads no
// catalogue, and how a preference resolves against the computer's languages.

export const LANGUAGES = ["en", "de", "es", "fr", "it", "pt-BR", "ru", "ja", "ko", "zh-Hans"] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_PREFERENCES = ["system", ...LANGUAGES] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

export const OWN_NAMES: Record<Language, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  "pt-BR": "Português (Brasil)",
  ru: "Русский",
  ja: "日本語",
  ko: "한국어",
  "zh-Hans": "简体中文",
};

/** The language a BCP 47 tag belongs to, or null when the set has none for it. */
export function languageOf(tag: string): Language | null {
  const lower = tag.toLowerCase().replace(/_/g, "-");
  const [primary] = lower.split("-");
  if (primary === "zh") return "zh-Hans";
  if (primary === "pt") return "pt-BR";
  return (LANGUAGES as readonly string[]).includes(primary ?? "") ? (primary as Language) : null;
}

/** System resolves to the first of the computer's languages in the set, else English. */
export function resolveLanguage(preference: LanguagePreference, computer: readonly string[]): Language {
  if (preference !== "system") return preference;
  for (const tag of computer) {
    const language = languageOf(tag);
    if (language) return language;
  }
  return "en";
}

/** The locale numbers and dates are formatted in: the computer's own when it speaks the interface language. */
export function formattingLocale(language: Language, systemLocale: string): string {
  return languageOf(systemLocale) === language ? systemLocale : language;
}

export function normalizePreference(value: unknown): LanguagePreference {
  return typeof value === "string" && (LANGUAGE_PREFERENCES as readonly string[]).includes(value)
    ? (value as LanguagePreference)
    : "system";
}
