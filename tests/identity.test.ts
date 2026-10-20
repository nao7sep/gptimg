// The copyright holder is package.json's author; every place that names it is
// checked against that, so a change of holder cannot leave a stale copy.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const holder = (JSON.parse(read("../package.json")) as { author: { name: string } }).author.name;
const CATALOGUES = fileURLToPath(new URL("../src/shared/i18n/catalogues/", import.meta.url));

describe("the copyright holder", () => {
  it("is the author in the packaged copyright and in every language's About text", () => {
    expect(/^copyright:\s*(.*)$/m.exec(read("../electron-builder.yml"))?.[1]).toContain(holder);
    for (const file of readdirSync(CATALOGUES).filter((name) => name.endsWith(".json"))) {
      const catalogue = JSON.parse(readFileSync(`${CATALOGUES}${file}`, "utf8")) as Record<string, string>;
      expect(catalogue["about.copyright"], file).toContain(holder);
    }
  });
});
