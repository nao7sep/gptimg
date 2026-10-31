import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../../src/main/config.ts";
import { withHeader } from "../../src/main/file-header.ts";
import { builtInSettings } from "../../src/shared/settings.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "gptimg-config-")), "config.json");

describe("config.json", () => {
  it("reads a missing file as built-ins and first run writes nothing", async () => {
    const path = fresh();
    const loaded = await loadConfig(path);
    expect(loaded.settings).toEqual(builtInSettings());
    expect(await saveConfig(path, loaded.settings, loaded.unknown, false)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("writes only differing sets, keeps unknown keys and keeps the file once every set is back", async () => {
    const path = fresh();
    writeFileSync(path, JSON.stringify(withHeader("config", { theme: "dark", future: 1 })));
    const loaded = await loadConfig(path);
    await saveConfig(path, { ...loaded.settings, language: "ja" }, loaded.unknown, true);
    const saved = readFileSync(path, "utf8");
    expect(JSON.parse(saved)).toEqual(withHeader("config", { future: 1, theme: "dark", language: "ja" }));
    expect(Object.keys(JSON.parse(saved)).slice(0, 2)).toEqual(["format", "writer"]);
    await saveConfig(path, builtInSettings(), {}, true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(withHeader("config", {}));
  });

  it("refuses a file it cannot understand, without a config header or of a newer format, saying which", async () => {
    for (const [text, reason] of [
      ["[1,2", "unreadable"],
      [JSON.stringify({ theme: "dark" }), "unreadable"],
      [JSON.stringify({ format: { owner: "gptimg", kind: "state", version: 1 }, theme: "dark" }), "unreadable"],
      [JSON.stringify({ format: { owner: "gptimg", kind: "config", version: 2 }, theme: "dark" }), "newer"],
    ] as const) {
      const path = fresh();
      writeFileSync(path, text);
      expect((await loadConfig(path)).refused).toBe(reason);
      await expect(saveConfig(path, { ...builtInSettings(), theme: "light" }, {}, true)).rejects.toMatchObject({ reason });
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("checks the file again at the write and never saves over one replaced since launch", async () => {
    const path = fresh();
    writeFileSync(path, JSON.stringify(withHeader("config", { theme: "dark" })));
    const loaded = await loadConfig(path);
    const newer = JSON.stringify({ format: { owner: "gptimg", kind: "config", version: 2 } });
    writeFileSync(path, newer);
    await expect(saveConfig(path, loaded.settings, loaded.unknown, true, loaded.kept)).rejects.toMatchObject({ reason: "newer" });
    expect(readFileSync(path, "utf8")).toBe(newer);
  });

  it("keeps an invalid stored value on save until the user changes that set", async () => {
    const path = fresh();
    writeFileSync(path, JSON.stringify(withHeader("config", { theme: "purple", language: "xx", future: 1 })));
    const loaded = await loadConfig(path);
    expect(loaded.invalid.sort()).toEqual(["language", "theme"]);
    await saveConfig(path, { ...loaded.settings, theme: "dark" }, loaded.unknown, true, loaded.kept);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(withHeader("config", { future: 1, theme: "dark", language: "xx" }));
  });
});
