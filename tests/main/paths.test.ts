import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../../src/main/config.ts";
import { DATA_DIR_ENV, DataDirError, dataRoot, ensureDataRoot, suggestedSessionsDir } from "../../src/main/paths.ts";
import { builtInSettings } from "../../src/shared/settings.ts";

const temporary: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "gptimg-paths-"));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("machine storage root", () => {
  it.each([undefined, "", "  "])("uses the platform home for an empty override (%s)", (override) => {
    expect(dataRoot({ [DATA_DIR_ENV]: override })).toEqual({ dir: join(homedir(), ".gptimg"), fromEnv: false });
  });

  it("resolves relative overrides against home in every launch directory", () => {
    const launches = [fresh(), parse(homedir()).root];
    const cwd = vi.spyOn(process, "cwd");
    for (const launch of launches) {
      cwd.mockReturnValue(launch);
      expect(dataRoot({ [DATA_DIR_ENV]: "profiles/images" })).toEqual({ dir: resolve(homedir(), "profiles/images"), fromEnv: true });
    }
    expect(cwd).not.toHaveBeenCalled();
  });

  it.each([
    ["~", ""],
    ["~/images", "images"],
    ["$PROFILE/images", "profiles/images"],
    ["${PROFILE}/images", "profiles/images"],
    ["%PROFILE%/images", "profiles/images"],
  ])("expands %s before resolving against home", (override, relative) => {
    expect(dataRoot({ [DATA_DIR_ENV]: override, PROFILE: "profiles" })).toEqual({ dir: resolve(homedir(), relative), fromEnv: true });
  });

  it("expands once, keeping variable-like folder names in replacement values literal", () => {
    expect(dataRoot({ [DATA_DIR_ENV]: "$PROFILE", PROFILE: "photos/$NAME", NAME: "other" }).dir).toBe(resolve(homedir(), "photos/$NAME"));
  });

  it.each(["$MISSING", "${MISSING}/images", "%MISSING%/images"])("rejects an unresolved override (%s) without selecting a replacement root", (override) => {
    expect(() => ensureDataRoot({ [DATA_DIR_ENV]: override })).toThrow(DataDirError);
    try {
      ensureDataRoot({ [DATA_DIR_ENV]: override });
    } catch (error) {
      expect(error).toMatchObject({ fromEnv: true, dir: override });
    }
  });

  it("reports an unusable explicit root and leaves its contents alone", () => {
    const file = join(fresh(), "profile");
    writeFileSync(file, "keep");
    expect(() => ensureDataRoot({ [DATA_DIR_ENV]: file })).toThrow(DataDirError);
    expect(readFileSync(file, "utf8")).toBe("keep");
  });

  it("creates the expanded root privately and routes real configuration reads and writes through it", async () => {
    const base = fresh();
    const dir = join(base, "profile");
    vi.stubEnv(DATA_DIR_ENV, "$GPTIMG_TEST_PROFILE/profile");
    vi.stubEnv("GPTIMG_TEST_PROFILE", base);
    const paths = ensureDataRoot();
    expect(paths.root).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      chmodSync(dir, 0o755);
      ensureDataRoot({ [DATA_DIR_ENV]: dir });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    const sessionsDir = join(base, "$LITERAL", "%PHOTOS%");
    const settings = { ...builtInSettings(), sessionsDir };
    await saveConfig(paths.config, settings, {}, false);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).sessionsDir).toBe(sessionsDir);
    expect((await loadConfig(paths.config)).settings.sessionsDir).toBe(sessionsDir);
    expect(existsSync(sessionsDir)).toBe(false);
    expect(suggestedSessionsDir(join(base, "Documents"))).toBe(join(base, "Documents", "GptImg"));
  });
});
