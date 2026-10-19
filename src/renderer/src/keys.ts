// A key's printed name: the named keys are translated, letters stay as they are.
import type { useI18n } from "./i18n.tsx";

const KEY_NAMES = ["Cmd", "Ctrl", "Shift", "Enter", "Escape", "Up", "Down", "Comma", "Slash"] as const;

export function keyName(key: string, t: ReturnType<typeof useI18n>["t"]): string {
  return (KEY_NAMES as readonly string[]).includes(key) ? t(`keys.${key as (typeof KEY_NAMES)[number]}`) : key;
}
