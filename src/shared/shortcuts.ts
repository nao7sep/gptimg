// Every keyboard shortcut, declared once: the menu takes its accelerators from
// here, the renderer matches keys with the same table, and the Shortcuts
// window lists it (keyboard-shortcut-conventions).
import type { MenuCommand } from "./api.ts";
import type { MessageKey } from "./i18n/translator.ts";

export interface Shortcut {
  command: MenuCommand;
  /** Electron's accelerator; CmdOrCtrl is Cmd on macOS and Ctrl elsewhere. */
  accelerator: string;
  /** The key as KeyboardEvent.key reports it, lower-cased. */
  key: string;
  shift?: boolean;
  label: MessageKey;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { command: "newChat", accelerator: "CmdOrCtrl+N", key: "n", label: "shortcuts.newChat" },
  { command: "attach", accelerator: "CmdOrCtrl+O", key: "o", label: "shortcuts.attach" },
  { command: "settings", accelerator: "CmdOrCtrl+,", key: ",", label: "shortcuts.settings" },
  { command: "shortcuts", accelerator: "CmdOrCtrl+/", key: "/", label: "shortcuts.shortcuts" },
  { command: "close", accelerator: "CmdOrCtrl+W", key: "w", label: "shortcuts.close" },
];

/** Keys handled inside the window only (no menu item): listed for the Shortcuts window. */
export const LOCAL_KEYS: readonly { keys: readonly string[]; label: MessageKey }[] = [
  { keys: ["Enter"], label: "shortcuts.send" },
  { keys: ["Shift", "Enter"], label: "shortcuts.newLine" },
  { keys: ["Escape"], label: "shortcuts.escape" },
  { keys: ["Up", "Down"], label: "shortcuts.moveChats" },
  { keys: ["F2"], label: "shortcuts.rename" },
];

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The command a key press means, bound to both Cmd and Ctrl
 * (`(meta || ctrl) && !alt`). On macOS the Ctrl half stands down in an
 * editable target, where Ctrl keys move the caret.
 */
export function commandFor(event: KeyLike, mac: boolean, editable: boolean): MenuCommand | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (mac && event.ctrlKey && !event.metaKey && editable) return null;
  const key = event.key.toLowerCase();
  const match = SHORTCUTS.find((s) => s.key === key && !!s.shift === event.shiftKey);
  return match?.command ?? null;
}

/** How an accelerator is shown: Cmd on macOS, Ctrl elsewhere, keys spelled out. */
export function displayKeys(accelerator: string, mac: boolean): string[] {
  return accelerator.split("+").map((part) => {
    if (part === "CmdOrCtrl") return mac ? "Cmd" : "Ctrl";
    if (part === ",") return "Comma";
    if (part === "/") return "Slash";
    return part;
  });
}
