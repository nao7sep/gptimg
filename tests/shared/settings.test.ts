import { describe, expect, it } from "vitest";
import {
  builtInSettings,
  differingSets,
  effectiveThinking,
  readSets,
  setsEqual,
  thinkingAfterModelChange,
  validateSet,
} from "../../src/shared/settings.ts";

describe("settings sets", () => {
  it("stores nothing while every set equals its built-in", () => {
    expect(differingSets(builtInSettings())).toEqual({});
  });

  it("stores a changed set whole, and a model id compared trimmed and case-insensitive", () => {
    const settings = { ...builtInSettings(), contentFont: { ...builtInSettings().contentFont, readingSize: 18 } };
    expect(differingSets(settings)).toEqual({ contentFont: { ...builtInSettings().contentFont, readingSize: 18 } });
    const chat = builtInSettings()["openai.chat"];
    expect(setsEqual("openai.chat", ` ${chat.toUpperCase()} `, chat)).toBe(true);
    expect(differingSets({ ...builtInSettings(), "openai.chat": ` ${chat.toUpperCase()}` })).toEqual({});
  });

  it("does not store a thinking choice equal to the row's default, so it follows the row", () => {
    const settings = builtInSettings();
    expect(differingSets({ ...settings, "openai.thinking.chat": "medium" })).toEqual({});
    expect(differingSets({ ...settings, "openai.thinking.chat": "high" })).toEqual({ "openai.thinking.chat": "high" });
  });

  it("reads absent keys as built-ins, falls back on an invalid set and keeps unknown keys", () => {
    const loaded = readSets({ theme: "neon", language: "ja", futureKey: { a: 1 } });
    expect(loaded.settings.theme).toBe("system");
    expect(loaded.settings.language).toBe("ja");
    expect(loaded.invalid).toEqual(["theme"]);
    expect(loaded.unknown).toEqual({ futureKey: { a: 1 } });
  });

  it("validates what the app owns and keeps free text as written", () => {
    expect(validateSet("timeZone", "Asia/Tokyo")).toBeNull();
    expect(validateSet("timeZone", "Mars/Olympus")).not.toBeNull();
    expect(validateSet("openai.chat", "some-future-model")).toBeNull();
    expect(validateSet("openai.chat", "  ")).not.toBeNull();
    expect(validateSet("contentFont", { family: "Georgia", readingSize: 30, writingSize: 14, lineHeight: 1.5 })).toBe("settings.error.fontSize");
  });
});

describe("thinking follows the model's row", () => {
  it("resets to the new row's default only when the model reaches a different listed row", () => {
    expect(thinkingAfterModelChange("gpt-5.6-terra", "gpt-6-luna", "high")).toEqual({ thinking: "none", lastRow: "gpt-6-luna" });
    expect(thinkingAfterModelChange("gpt-5.6-terra", "gpt-5.6-terra", "high")).toEqual({ thinking: "high", lastRow: "gpt-5.6-terra" });
  });

  it("keeps the choice while the typed id has no row", () => {
    expect(thinkingAfterModelChange("gpt-5.6-terra", "gpt-5.6-ter", "high")).toEqual({ thinking: "high", lastRow: "gpt-5.6-terra" });
  });

  it("from no listed row, keeps the stored choice when the first row reached offers it", () => {
    expect(thinkingAfterModelChange(null, "gpt-5.6-terra", "high")).toEqual({ thinking: "high", lastRow: "gpt-5.6-terra" });
    expect(thinkingAfterModelChange(null, "gpt-6-astra", "none")).toEqual({ thinking: "medium", lastRow: "gpt-6-astra" });
  });

  it("sends no thinking for an id with no row", () => {
    expect(effectiveThinking({ ...builtInSettings(), "openai.chat": "unknown-model" })).toBeUndefined();
  });
});
