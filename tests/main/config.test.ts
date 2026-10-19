import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../../src/main/config.ts";
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
    writeFileSync(path, JSON.stringify({ theme: "dark", future: 1 }));
    const loaded = await loadConfig(path);
    await saveConfig(path, { ...loaded.settings, language: "ja" }, loaded.unknown, true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ future: 1, theme: "dark", language: "ja" });
    await saveConfig(path, builtInSettings(), {}, true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("locks saving when the file cannot be understood", async () => {
    const path = fresh();
    writeFileSync(path, "[1,2");
    const loaded = await loadConfig(path);
    expect(loaded.locked).toBe(true);
    expect(loaded.problem?.key).toBe("settings.problem.malformed");
  });
});
