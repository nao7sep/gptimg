import { describe, expect, it } from "vitest";
import { commandFor, displayKeys, SHORTCUTS } from "../../src/shared/shortcuts.ts";

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("shortcuts", () => {
  it("binds both Cmd and Ctrl, never with Alt", () => {
    expect(commandFor(key("n", { metaKey: true }), true, false)).toBe("newChat");
    expect(commandFor(key("n", { ctrlKey: true }), true, false)).toBe("newChat");
    expect(commandFor(key("N", { ctrlKey: true }), false, true)).toBe("newChat");
    expect(commandFor(key("n", { metaKey: true, altKey: true }), true, false)).toBeNull();
  });

  it("lets the macOS Ctrl half stand down in text, where Ctrl keys move the caret", () => {
    expect(commandFor(key("n", { ctrlKey: true }), true, true)).toBeNull();
    expect(commandFor(key("n", { metaKey: true }), true, true)).toBe("newChat");
  });

  it("shows Cmd on macOS and Ctrl elsewhere, with keys spelled out", () => {
    expect(displayKeys("CmdOrCtrl+,", true)).toEqual(["Cmd", "Comma"]);
    expect(displayKeys("CmdOrCtrl+/", false)).toEqual(["Ctrl", "Slash"]);
  });

  it("gives every command one key", () => {
    const keys = SHORTCUTS.map((s) => `${s.shift ? "shift+" : ""}${s.key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
