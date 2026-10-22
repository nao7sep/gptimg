// The catalogue gates (localization-conventions): every language has every
// key with exactly its plural categories, keeps every placeholder, has an
// ellipsis exactly where English does, holds no literal no-break space, and
// copies English only where a value is deliberately literal.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGLISH, loadCatalogue } from "../../src/shared/i18n/catalogues.ts";
import { LANGUAGES, type Language } from "../../src/shared/i18n/languages.ts";

const PLURAL = /\.(zero|one|two|few|many|other)$/;
const others = LANGUAGES.filter((l) => l !== "en");

function shape(catalogue: Record<string, string>, language: Language): string[] {
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  const keys = new Set<string>();
  for (const key of Object.keys(catalogue)) {
    if (PLURAL.test(key)) {
      const base = key.replace(PLURAL, "");
      for (const category of categories) keys.add(`${base}.${category}`);
    } else keys.add(key);
  }
  return [...keys].sort();
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

/** Values that are the same word in a language, or literal by rule (brands, keys printed on keyboards). */
const SAME_AS_ENGLISH: Partial<Record<Language, readonly string[]>> = {
  de: [
    "about.version",
    "composer.background.transparent",
    "export.format",
    "rail.label",
    "rail.sessions",
    "records.block.details",
    "records.field.chat",
    "records.field.status",
    "records.level.debug",
    "records.level.info",
    "settings.sessions",
    "settings.system",
    "settings.theme.system",
    "startup.details",
  ],
  es: [
    "nativeMenu.zoom",
    "rail.label",
    "rail.sessions",
    "records.block.error",
    "records.field.chat",
    "records.level.error",
    "records.level.info",
    "settings.general",
    "settings.sessions",
  ],
  fr: [
    "about.version",
    "composer.background.opaque",
    "composer.background.transparent",
    "composer.label",
    "composer.size.portrait",
    "conversation.label",
    "conversation.totals.other",
    "dialog.imageFilter",
    "export.format",
    "images.title",
    "menu.open",
    "nativeMenu.services",
    "nativeMenu.zoom",
    "rail.meta.other",
    "records.field.message",
    "records.level.info",
    "viewer.label",
  ],
  ja: ["composer.size.customShort"],
  ko: ["composer.size.customShort"],
  it: ["menu.open", "nativeMenu.file", "nativeMenu.zoom", "records.field.chat", "records.level.debug", "records.level.info"],
  "pt-BR": [
    "composer.size.ok",
    "menu.open",
    "nativeMenu.zoom",
    "rail.label",
    "rail.sessions",
    "records.field.chat",
    "records.field.status",
    "records.level.info",
    "settings.sessions",
  ],
};
const LITERAL_EVERYWHERE = [
  "settings.apiKeyPlaceholder",
  "settings.openai",
  "keys.Cmd",
  "keys.Ctrl",
  "keys.Escape",
  "keys.Shift",
  "keys.Enter",
  "viewer.count",
  "export.format.png",
  "export.format.jpeg",
  "export.format.webp",
  "export.dimensions",
  "export.pixels",
  "export.source",
  "viewer.info",
  "about.copyright",
  "about.github",
  "records.launch.entry",
];

describe.each(others)("%s catalogue", (language) => {
  let catalogue: Record<string, string>;

  it("loads and has exactly English's keys, with its own plural categories", async () => {
    catalogue = await loadCatalogue(language);
    expect(Object.keys(catalogue).sort()).toEqual(shape(ENGLISH, language));
  });

  it("keeps every placeholder, and a count in every plural form but one", async () => {
    catalogue ??= await loadCatalogue(language);
    for (const [key, value] of Object.entries(catalogue)) {
      const plural = PLURAL.test(key);
      const source = ENGLISH[key] ?? ENGLISH[key.replace(PLURAL, ".other")]!;
      const strip = (list: string[]) => (plural ? list.filter((p) => p !== "count") : list);
      expect(strip(placeholders(value)), key).toEqual(strip(placeholders(source)));
      if (plural && !key.endsWith(".one") && placeholders(ENGLISH[key.replace(PLURAL, ".other")]!).includes("count")) {
        expect(placeholders(value), key).toContain("count");
      }
    }
  });

  it("has an ellipsis exactly where English does", async () => {
    catalogue ??= await loadCatalogue(language);
    for (const [key, value] of Object.entries(catalogue)) {
      const source = ENGLISH[key] ?? ENGLISH[key.replace(PLURAL, ".other")]!;
      expect(value.includes("…"), key).toBe(source.includes("…"));
      expect(value.includes("..."), key).toBe(false);
    }
  });

  it("copies English only where the value is literal", async () => {
    catalogue ??= await loadCatalogue(language);
    const allowed = new Set([...LITERAL_EVERYWHERE, ...(SAME_AS_ENGLISH[language] ?? [])]);
    const copied = Object.entries(catalogue)
      .filter(([key, value]) => ENGLISH[key] === value && !allowed.has(key))
      .map(([key]) => key);
    expect(copied).toEqual([]);
  });
});

describe("catalogue files", () => {
  it.each(LANGUAGES)("%s holds no literal no-break space and is sorted", (language) => {
    const raw = readFileSync(new URL(`../../src/shared/i18n/catalogues/${language}.json`, import.meta.url), "utf8");
    expect(raw.includes(" ")).toBe(false);
    const keys = Object.keys(JSON.parse(raw));
    expect(keys).toEqual([...keys].sort());
  });

  it("English uses an ellipsis only for running status", () => {
    // Every one of these is a running status, shown only while its operation runs.
    expect(Object.entries(ENGLISH).filter(([, v]) => v.includes("…")).map(([k]) => k)).toEqual([
      "export.downloading",
      "export.reading",
      "export.strip.downloading",
      "export.strip.exporting",
      "export.strip.upscaling",
      "export.upscaling",
      "export.working",
      "rail.working",
      "records.loading",
    ]);
  });

  it("names System's resolved value", () => {
    expect(ENGLISH["settings.system"]).toContain("{value}");
  });
});
