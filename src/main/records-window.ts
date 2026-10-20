// The Records window: one secondary window over records.sqlite3. Opening it
// again brings the existing one forward; it remembers its own placement,
// follows the main window's language and theme, closes with the main window,
// and is told when a record is stored, at most once a second.
import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { windowBackground } from "./window-background.ts";

const RECORDS_WINDOW = { width: 1240, height: 820, minWidth: 720, minHeight: 440 } as const;
const REFRESH_MS = 1000;

export interface RecordsWindowDeps {
  preload: string;
  load: (window: BrowserWindow, hash: string) => void;
  title: () => string;
}

export class RecordsWindow {
  #window: BrowserWindow | null = null;
  #pending: NodeJS.Timeout | null = null;
  readonly #deps: RecordsWindowDeps;

  constructor(deps: RecordsWindowDeps) {
    this.#deps = deps;
  }

  open(): void {
    if (this.#window && !this.#window.isDestroyed()) {
      if (this.#window.isMinimized()) this.#window.restore();
      this.#window.show();
      this.#window.focus();
      return;
    }
    const win = new BrowserWindow({
      name: "records",
      windowStatePersistence: { bounds: true, displayMode: process.platform === "win32" },
      width: RECORDS_WINDOW.width,
      height: RECORDS_WINDOW.height,
      minWidth: RECORDS_WINDOW.minWidth,
      minHeight: RECORDS_WINDOW.minHeight,
      show: false,
      title: this.#deps.title(),
      backgroundColor: windowBackground(),
      webPreferences: { preload: this.#deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.#window = win;
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });
    win.on("closed", () => {
      this.#window = null;
    });
    this.#deps.load(win, "records");
  }

  /** A record was stored: refresh an open window, at most once a second. */
  changed(): void {
    if (!this.#window || this.#pending) return;
    this.#pending = setTimeout(() => {
      this.#pending = null;
      if (this.#window && !this.#window.isDestroyed()) this.#window.webContents.send("recordsChanged");
    }, REFRESH_MS);
  }

  /** The title follows the interface language. */
  retitle(): void {
    if (this.#window && !this.#window.isDestroyed()) this.#window.setTitle(this.#deps.title());
  }

  close(): void {
    if (this.#window && !this.#window.isDestroyed()) this.#window.close();
  }

  owns(window: BrowserWindow | null): boolean {
    return !!window && window === this.#window;
  }
}

export function rendererEntry(here: string): string {
  return join(here, "../renderer/index.html");
}
