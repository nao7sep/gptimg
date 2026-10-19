import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, getPreferredSystemLanguages: vi.fn(() => ["ja-JP", "en-US"]), getSystemLocale: vi.fn(() => "ja-JP") },
  systemPreferences: { setUserDefault: vi.fn(), removeUserDefault: vi.fn() },
}));
vi.mock("electron", () => electron);

const { chromiumLang, clearAppleLanguages, LanguageOwner, writeAppleLanguages } = await import("../../src/main/language.ts");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value });

describe("the interface language on macOS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.app.isPackaged = true;
    setPlatform("darwin");
    return () => Object.defineProperty(process, "platform", platform);
  });

  it("writes a saved choice to the app's own AppleLanguages and removes it for System", () => {
    writeAppleLanguages("ja", () => {});
    expect(electron.systemPreferences.setUserDefault).toHaveBeenCalledWith("AppleLanguages", "array", ["ja"]);
    writeAppleLanguages("system", () => {});
    expect(electron.systemPreferences.removeUserDefault).toHaveBeenCalledWith("AppleLanguages");
  });

  it("clears the app's own entry before the computer's languages are read", () => {
    clearAppleLanguages(() => {});
    expect(electron.systemPreferences.removeUserDefault).toHaveBeenCalledWith("AppleLanguages");
  });

  it("touches no defaults from an unpackaged run or off macOS", () => {
    electron.app.isPackaged = false;
    writeAppleLanguages("ja", () => {});
    clearAppleLanguages(() => {});
    electron.app.isPackaged = true;
    setPlatform("win32");
    writeAppleLanguages("de", () => {});
    expect(electron.systemPreferences.setUserDefault).not.toHaveBeenCalled();
    expect(electron.systemPreferences.removeUserDefault).not.toHaveBeenCalled();
  });

  it("logs a failed write and carries on", () => {
    electron.systemPreferences.setUserDefault.mockImplementationOnce(() => {
      throw new Error("denied");
    });
    const log = vi.fn();
    writeAppleLanguages("fr", log);
    expect(log).toHaveBeenCalled();
  });
});

describe("the language owner", () => {
  it("resolves System against the computer and formats in its locale", async () => {
    const owner = new LanguageOwner();
    owner.readComputer();
    await owner.use("system");
    expect(owner.info()).toMatchObject({ language: "ja", locale: "ja-JP", systemLanguage: "ja" });
    expect(await owner.use("de")).toBe(true);
    expect(owner.info().locale).toBe("de");
    expect(await owner.use("de")).toBe(false);
  });

  it("points Chromium at an explicit choice only", () => {
    expect(chromiumLang("zh-Hans")).toBe("zh-CN");
    expect(chromiumLang("system")).toBeNull();
  });
});
