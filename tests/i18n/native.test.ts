// The packaged app declares exactly the interface languages, and the Windows
// installer offers all ten with English first.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../../src/shared/i18n/languages.ts";

const yml = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8");
const list = (key: string) => {
  const match = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(yml);
  return match ? match[1]!.split(",").map((s) => s.trim()) : [];
};

describe("packaging languages", () => {
  it("declares every interface language in CFBundleLocalizations", () => {
    expect(list("CFBundleLocalizations")).toEqual([...LANGUAGES]);
  });

  it("lists ten installer languages, English first", () => {
    const installer = list("installerLanguages");
    expect(installer).toHaveLength(LANGUAGES.length);
    expect(installer[0]).toBe("en_US");
  });
});
