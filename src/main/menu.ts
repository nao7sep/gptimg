// The application menu, built from the nativeMenu.* keys and rebuilt when the
// language changes. Roles are kept, so Edit and Window still send the system's
// standard actions; app commands go to the focused window as MenuCommands.
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/api.ts";
import type { Translator } from "../shared/i18n/translator.ts";
import { SHORTCUTS } from "../shared/shortcuts.ts";

export function buildMenu(t: Translator, send: (command: MenuCommand) => void, dev: boolean): Menu {
  const mac = process.platform === "darwin";
  const item = (command: MenuCommand, label: string): MenuItemConstructorOptions => {
    const accelerator = SHORTCUTS.find((s) => s.command === command)?.accelerator;
    return { label, ...(accelerator && { accelerator }), click: () => send(command) };
  };

  const settings = item("settings", t.t("nativeMenu.settings"));
  const about = item("about", t.t("nativeMenu.about"));

  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      about,
      { type: "separator" },
      settings,
      { type: "separator" },
      { role: "services", label: t.t("nativeMenu.services") },
      { type: "separator" },
      { role: "hide", label: t.t("nativeMenu.hide") },
      { role: "hideOthers", label: t.t("nativeMenu.hideOthers") },
      { role: "unhide", label: t.t("nativeMenu.showAll") },
      { type: "separator" },
      { role: "quit", label: t.t("nativeMenu.quit") },
    ],
  };

  const file: MenuItemConstructorOptions = {
    label: t.t("nativeMenu.file"),
    submenu: [
      item("newChat", t.t("nativeMenu.newChat")),
      item("attach", t.t("nativeMenu.attach")),
      { type: "separator" },
      item("rename", t.t("nativeMenu.rename")),
      item("reveal", t.t(mac ? "nativeMenu.revealMac" : "nativeMenu.revealOther")),
      item("trash", t.t(mac ? "nativeMenu.trashMac" : "nativeMenu.trashOther")),
      { type: "separator" },
      ...(mac ? [] : [settings, { type: "separator" } as const]),
      item("close", t.t("nativeMenu.close")),
      ...(mac ? [] : [{ role: "quit", label: t.t("nativeMenu.quit") } as const]),
    ],
  };

  const edit: MenuItemConstructorOptions = {
    label: t.t("nativeMenu.edit"),
    submenu: [
      { role: "undo", label: t.t("nativeMenu.undo") },
      { role: "redo", label: t.t("nativeMenu.redo") },
      { type: "separator" },
      { role: "cut", label: t.t("nativeMenu.cut") },
      { role: "copy", label: t.t("nativeMenu.copy") },
      { role: "paste", label: t.t("nativeMenu.paste") },
      { role: "selectAll", label: t.t("nativeMenu.selectAll") },
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: t.t("nativeMenu.view"),
    submenu: [
      { role: "togglefullscreen", label: t.t("nativeMenu.fullScreen") },
      ...(dev ? [{ type: "separator" } as const, { role: "reload" } as const, { role: "toggleDevTools" } as const] : []),
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    role: "windowMenu",
    label: t.t("nativeMenu.window"),
    submenu: [
      { role: "minimize", label: t.t("nativeMenu.minimize") },
      { role: "zoom", label: t.t("nativeMenu.zoom") },
      ...(mac ? [{ type: "separator" } as const, { role: "front", label: t.t("nativeMenu.front") } as const] : []),
    ],
  };

  const help: MenuItemConstructorOptions = {
    role: "help",
    label: t.t("nativeMenu.help"),
    submenu: [item("shortcuts", t.t("nativeMenu.shortcuts")), item("records", t.t("nativeMenu.records")), ...(mac ? [] : [{ type: "separator" } as const, about])],
  };

  return Menu.buildFromTemplate(mac ? [appMenu, file, edit, view, windowMenu, help] : [file, edit, view, windowMenu, help]);
}
