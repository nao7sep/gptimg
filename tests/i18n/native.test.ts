// Every packaging language list in electron-builder.yml holds exactly the
// interface languages, each in the spelling its consumer takes, so adding or
// dropping a language without the packaging fails here. The installer offers
// English first.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LANGUAGES, type Language } from "../../src/shared/i18n/languages.ts";

const yml = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8");

/** A top-level section of the file: from its key to the next top-level key. */
function section(name: string): string {
  const start = yml.search(new RegExp(`^${name}:`, "m"));
  if (start < 0) return "";
  const rest = yml.slice(start + name.length + 1);
  const end = rest.search(/^\S/m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** A flow list (`key: [a, b]`) in a section. */
function list(text: string, key: string): string[] {
  const match = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(text);
  return match ? match[1]!.split(",").map((s) => s.trim()) : [];
}

// Each consumer's spelling of an interface language; the Record type makes a new language a compile error here.
const MAC_BUNDLE: Record<Language, string> = { en: "en", de: "de", es: "es", fr: "fr", it: "it", "pt-BR": "pt-BR", ru: "ru", ja: "ja", ko: "ko", "zh-Hans": "zh-Hans" };
const MAC_ELECTRON: Record<Language, string> = { en: "en", de: "de", es: "es", fr: "fr", it: "it", "pt-BR": "pt_BR", ru: "ru", ja: "ja", ko: "ko", "zh-Hans": "zh_CN" };
const WIN_ELECTRON: Record<Language, string> = { en: "en-US", de: "de", es: "es", fr: "fr", it: "it", "pt-BR": "pt-BR", ru: "ru", ja: "ja", ko: "ko", "zh-Hans": "zh-CN" };
const NSIS: Record<Language, string> = { en: "en_US", de: "de_DE", es: "es_ES", fr: "fr_FR", it: "it_IT", "pt-BR": "pt_BR", ru: "ru_RU", ja: "ja_JP", ko: "ko_KR", "zh-Hans": "zh_CN" };

const spelled = (table: Record<Language, string>) => LANGUAGES.map((language) => table[language]);

describe("packaging languages", () => {
  it("declares every interface language in CFBundleLocalizations", () => {
    expect(list(section("mac"), "CFBundleLocalizations")).toEqual(spelled(MAC_BUNDLE));
  });

  it("keeps Electron's own strings in exactly the interface languages, on macOS and on Windows", () => {
    expect(list(section("mac"), "electronLanguages")).toEqual(spelled(MAC_ELECTRON));
    expect(list(section("win"), "electronLanguages")).toEqual(spelled(WIN_ELECTRON));
  });

  it("offers every interface language in the installer, English first", () => {
    expect(list(section("nsis"), "installerLanguages")).toEqual(spelled(NSIS));
  });
});
