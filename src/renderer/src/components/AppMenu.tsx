// The in-window menu (app-chrome-conventions, In-window menu): the app's own
// actions, then Settings, then Records, then Keyboard Shortcuts and About.
// A menu button and a popover with one tab stop; the arrow keys move, Enter
// chooses, Escape closes and returns focus to the button.
import { useEffect, useRef, useState } from "react";
import type { MenuCommand } from "../../../shared/api.ts";
import type { MessageKey } from "../../../shared/i18n/translator.ts";
import { displayKeys, SHORTCUTS } from "../../../shared/shortcuts.ts";
import { useI18n } from "../i18n.tsx";
import { keyName } from "../keys.ts";
import { MenuIcon } from "./icons.tsx";

type Item = { command: MenuCommand | "chatsFolder"; label: MessageKey } | "separator";

const ITEMS: readonly Item[] = [
  { command: "newChat", label: "rail.new" },
  { command: "chatsFolder", label: "menu.showChatsFolder" },
  "separator",
  { command: "settings", label: "nativeMenu.settings" },
  "separator",
  { command: "records", label: "nativeMenu.records" },
  "separator",
  { command: "shortcuts", label: "nativeMenu.shortcuts" },
  { command: "about", label: "nativeMenu.about" },
];

export function AppMenu({ mac, onCommand }: { mac: boolean; onCommand: (command: MenuCommand | "chatsFolder") => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = ITEMS.filter((item): item is Exclude<Item, "separator"> => item !== "separator");

  useEffect(() => {
    if (!open) return;
    menu.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const choose = (command: MenuCommand | "chatsFolder") => {
    setOpen(false);
    onCommand(command);
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(items.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(items[active]!.command);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const shortcutOf = (command: string) => {
    const accelerator = SHORTCUTS.find((s) => s.command === command)?.accelerator;
    return accelerator ? displayKeys(accelerator, mac).map((k) => keyName(k, t)).join("+") : null;
  };

  let index = -1;
  return (
    <div className="app-menu">
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("menu.open")}
        title={t("menu.open")}
        onClick={() => {
          setActive(0);
          setOpen((v) => !v);
        }}
      >
        <MenuIcon />
      </button>
      {open && (
        <div
          ref={menu}
          className="menu-popover"
          role="menu"
          tabIndex={-1}
          aria-label={t("menu.open")}
          aria-activedescendant={`menu-item-${active}`}
          onKeyDown={onKey}
        >
          {ITEMS.map((item, i) => {
            if (item === "separator") return <div key={`sep-${i}`} className="menu-separator" role="separator" />;
            index += 1;
            const at = index;
            const keys = shortcutOf(item.command);
            return (
              <div
                key={item.command}
                id={`menu-item-${at}`}
                role="menuitem"
                className={`menu-item${at === active ? " active" : ""}`}
                onMouseEnter={() => setActive(at)}
                onClick={() => choose(item.command)}
              >
                <span>{t(item.label)}</span>
                {keys && <span className="menu-keys">{keys}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
