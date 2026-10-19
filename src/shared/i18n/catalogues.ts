// One dynamic import per catalogue, so each process loads only the interface
// language and English, and the bundler gives each language its own chunk.
import english from "./catalogues/en.json";
import type { Language } from "./languages.ts";

export type Catalogue = Record<string, string>;

const LOADERS: Record<Language, () => Promise<{ default: Catalogue }>> = {
  en: async () => ({ default: english }),
  de: () => import("./catalogues/de.json"),
  es: () => import("./catalogues/es.json"),
  fr: () => import("./catalogues/fr.json"),
  it: () => import("./catalogues/it.json"),
  "pt-BR": () => import("./catalogues/pt-BR.json"),
  ru: () => import("./catalogues/ru.json"),
  ja: () => import("./catalogues/ja.json"),
  ko: () => import("./catalogues/ko.json"),
  "zh-Hans": () => import("./catalogues/zh-Hans.json"),
};

export const ENGLISH: Catalogue = english;

export async function loadCatalogue(language: Language): Promise<Catalogue> {
  return (await LOADERS[language]()).default;
}
