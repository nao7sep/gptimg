// GptImg's main process: settles storage, language and theme before any
// window exists, owns every store, and answers the window's requests.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeTheme, powerMonitor, session, shell } from "electron";
import type { AppFailure, BootInfo, GptImgApi, MenuCommand, Outcome, SendRequest } from "../shared/api.ts";
import { DraftPreviews } from "./draft-previews.ts";
import { extensionOf, type ExportRequest } from "../shared/export.ts";
import { message } from "../shared/i18n/translator.ts";
import { INITIAL_WINDOW, windowMinimum } from "../shared/layout.ts";
import { SET_KEYS, validateSet, type Settings } from "../shared/settings.ts";
import { parseUiState, type UiState } from "../shared/ui-state.ts";
import { KeyStore } from "./api-keys.ts";
import { loadConfig, saveConfig, type LoadedConfig } from "./config.ts";
import { APP_WRITER, readHeader, withHeader } from "./file-header.ts";
import { json, readText, writeTextAtomic } from "./files.ts";
import { ExportRunner, folderOf } from "./export.ts";
import { IMAGE_EXTENSIONS, ImageAccess, isImagePath, registerImageScheme } from "./images.ts";
import { chromiumLang, clearAppleLanguages, earlyPreferences, LanguageOwner, writeAppleLanguages } from "./language.ts";
import { buildMenu } from "./menu.ts";
import { RecordsWindow } from "./records-window.ts";
import { DataDirError, ensureDataRoot, suggestedChatsDir, type AppPaths } from "./paths.ts";
import { startStores, type Stores, type StoreRecords } from "./stores.ts";
import { GptImg } from "gptimgsdk";
import { chatClients } from "./sdk.ts";
import { isChatFolder, readChat, renameChat, ChatError, chatDir } from "./chats.ts";
import { summarize } from "../shared/chat.ts";
import { ChatCatalog } from "./chat-catalog.ts";
import type { RecordQuery, RecordRef } from "../shared/records.ts";
import { TurnRunner } from "./turns.ts";
import { navigationAllowed } from "./navigation.ts";
import { windowBackground } from "./window-background.ts";

declare const __APP_VERSION__: string;

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const here = import.meta.dirname;
const EXIT_DEADLINE_MS = 3_000;
/**
 * Ends the process at once at the exit deadline. A worker blocked in SQLite or
 * on a stalled disk keeps Electron's `app.exit` waiting, while SIGKILL ends it.
 */
function endNow(): void {
  console.error("[gptimg] quitting did not finish in time; ending GptImg");
  process.kill(process.pid, "SIGKILL");
}
/** The OS-driven end of the app (shutdown, logout, session end), set once start has its owners. */
let osExit: () => void = () => app.exit(0);

app.setName("GptImg");
registerImageScheme();

// Framework state and the instance lock share the selected storage root.
try {
  const paths = ensureDataRoot();
  mkdirSync(join(paths.root, "electron", "session"), { recursive: true, mode: 0o700 });
  app.setPath("userData", join(paths.root, "electron"));
  app.setPath("sessionData", join(paths.root, "electron", "session"));
  if (!app.requestSingleInstanceLock()) app.quit();
  else void start(paths);
} catch (error) { void showStartupFailure(error); }

interface State {
  paths: AppPaths;
  config: LoadedConfig;
  configExisted: boolean;
  ui: UiState;
  /** False when state.json holds a newer format, which is left untouched. */
  uiWritable: boolean;
  keys: KeyStore;
  records: StoreRecords;
  backups: Stores["backups"];
  language: LanguageOwner;
  turns: TurnRunner;
  exports: ExportRunner;
  recordsWindow: RecordsWindow;
  catalog: ChatCatalog;
  images: ImageAccess;
  window: BrowserWindow | null;
  quitConfirmed: boolean;
  quitAsking: boolean;
  windowDirty: boolean;
  rootChanging: boolean;
}

async function start(paths: AppPaths): Promise<void> {
  const early = earlyPreferences(paths.config);
  const lang = chromiumLang(early.language);
  if (lang) app.commandLine.appendSwitch("lang", lang);

  await app.whenReady();

  const launchId = randomUUID();
  const stores = startStores({
    recordsPath: paths.records, logsDir: paths.logs, backupsPath: paths.backups, sessionId: launchId, version: __APP_VERSION__,
  });
  const { records, backups } = stores;
  records.log("info", "app.start", { version: __APP_VERSION__, platform: process.platform, dataDir: paths.root });

  const language = new LanguageOwner();
  clearAppleLanguages((error) => records.log("warn", "language.appleLanguagesFailed", { error: String(error) }));
  language.readComputer();

  const configRead = early.read;
  const config = await loadConfig(paths.config, configRead);
  await language.use(config.settings.language);
  writeAppleLanguages(config.settings.language, (error) => records.log("warn", "language.appleLanguagesFailed", { error: String(error) }));
  nativeTheme.themeSource = config.settings.theme;
  if (config.problem) records.log("warn", "settings.loadProblem", { problem: config.problem });

  const stateRead = await readText(paths.state);
  let ui = parseUiState(null);
  // A newer state.json is left untouched: this build keeps its state in memory only.
  let stateWritable = true;
  if (stateRead.kind === "ok") {
    try {
      const header = readHeader(JSON.parse(stateRead.text), "state");
      if (header.kind === "ok") ui = parseUiState(header.body);
      else if (header.kind === "newer") stateWritable = false;
    } catch {
      // Window and pane state is disposable: a bad copy is dropped.
    }
  }

  // Pasted images from an earlier launch that were never sent.
  await rm(paths.staging, { recursive: true, force: true }).catch(() => {});

  const keys = new KeyStore(paths.apiKeys, process.env, (_event, fields) => records.log("warn", "apiKeys.modeTightened", fields));

  const state: State = {
    paths,
    config,
    configExisted: configRead.kind !== "absent",
    ui,
    uiWritable: stateWritable,
    keys,
    records,
    backups,
    language,
    turns: null as unknown as TurnRunner,
    exports: new ExportRunner({
      sdk: new GptImg({ caller: APP_WRITER }),
      records,
      progress: (progress) => state.window?.webContents.send("progress", progress),
    }),
    recordsWindow: new RecordsWindow({
      preload: join(here, "../preload/index.cjs"),
      load: (win, hash) => {
        harden(win);
        if (DEV_URL) void win.loadURL(`${DEV_URL}#${hash}`);
        else void win.loadFile(join(here, "../renderer/index.html"), { hash });
      },
      title: () => language.translator.t("records.title"),
    }),
    catalog: new ChatCatalog((change) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("chatsChanged", change);
    }),
    images: new ImageAccess(() => [state.config.settings.chatsDir, paths.staging]),
    window: null,
    quitConfirmed: false,
    quitAsking: false,
    windowDirty: false,
    rootChanging: false,
  };
  const drafts = new DraftPreviews(paths.staging, (chatFolder, path) => {
    state.window?.webContents.send("turnDraft", { chatFolder, path });
  });
  state.turns = new TurnRunner({
    sdk: chatClients(APP_WRITER),
    records,
    settings: () => state.config.settings,
    apiKey: () => keys.resolve(),
    authorizeImage: (path) => state.images.allowed(path),
    backup: (path, text) => backups.keep(path, text),
    saved: (root, id, doc) => state.catalog.change(root, id, summarize(id, doc)),
    started: (requestId, chat) => state.window?.webContents.send("turnStarted", { requestId, chat }),
    draft: (chatFolder, draft) => void drafts.show(chatFolder, draft),
    releaseStaged: (path) => {
      if (dirname(path) === paths.staging) void rm(path, { force: true });
    },
  });
  state.images.install();
  installCsp();
  installIpc(state);

  const applyMenu = () =>
    Menu.setApplicationMenu(buildMenu(language.translator, (command) => sendMenu(state, command), !app.isPackaged));
  applyMenu();
  language.onChange((info) => {
    applyMenu();
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("language", info);
    state.recordsWindow.retitle();
  });
  records.onChange(() => state.recordsWindow.changed());

  createWindow(state);

  app.on("second-instance", () => {
    const win = state.window;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("activate", () => {
    if (!state.window) createWindow(state);
  });
  app.on("window-all-closed", () => app.quit());
  // Every quit has one exit deadline: running turns and exports are cancelled,
  // then the store worker writes what is pending, so a cancelled paid turn records
  // its outcome before the stores close. Whatever has not finished at the deadline
  // ends with the process, and the turn's recorded `provider.call` event stays as
  // the evidence (transaction conventions).
  let exiting = false;
  let exitReady = false;
  const exitWithin = (then: () => void) => {
    if (exiting) return;
    exiting = true;
    state.quitConfirmed = true;
    setTimeout(endNow, EXIT_DEADLINE_MS);
    void Promise.all([state.turns.cancelAll(), state.exports.cancel()]).then(then);
  };
  const teardown = (drain: boolean) => {
    records.log("info", "app.quit");
    return stores.close({ drain });
  };
  app.on("before-quit", (event) => {
    if (exitReady) return;
    // Ordinary closes and launcher replacement keep the window alive until one decision.
    if (state.quitConfirmed || (!state.turns.busy && !state.exports.busy && !state.windowDirty)) {
      event.preventDefault();
      exitWithin(() => { exitReady = true; app.quit(); });
      return;
    }
    event.preventDefault();
    if (state.quitAsking) return;
    state.quitAsking = true;
    const t = language.translator;
    const owner = state.window ?? undefined;
    const options = {
      type: "warning" as const,
      buttons: [t.t("quit.cancel"), t.t("quit.confirm")],
      defaultId: 0,
      cancelId: 0,
      message: t.t("quit.title"),
      detail: t.t("quit.detail"),
    };
    void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)).then(({ response }) => {
      state.quitAsking = false;
      if (response !== 1) return;
      state.quitConfirmed = true;
      app.quit();
    }).catch((error) => { state.quitAsking = false; records.log("error", "window.closeFailed", { error: String(error) }); });
  });
  // OS takeover never asks; it draws on the same exit deadline and then exits.
  // Its pending writes are skipped, so nothing holds up the restart.
  osExit = () => exitWithin(() => { void teardown(false).then(() => app.exit(0)); });
  // Electron passes the event though its typings omit it; preventing it delays the shutdown until the exit ends.
  powerMonitor.on("shutdown", (...args: unknown[]) => { (args[0] as Electron.Event).preventDefault(); osExit(); });
  app.on("will-quit", (event) => {
    event.preventDefault();
    void teardown(true).then(() => app.exit(0));
  });
}


/**
 * GptImg could not start: an app-drawn window in the computer's language says
 * why and closes the app. Nothing has been written. A window cannot be shown
 * at all only when even that fails; then the system's own error box speaks.
 */
async function showStartupFailure(error: unknown): Promise<void> {
  await app.whenReady();
  const language = new LanguageOwner();
  language.readComputer();
  await language.use("system");
  const t = language.translator;
  const dir = error instanceof DataDirError ? error.dir : "";
  const message = error instanceof DataDirError && error.fromEnv ? message_("startup.storageEnv", { path: dir }) : message_("startup.storage", { path: dir });
  ipcMain.handle("startupFailure", () => ({ language: language.info(), message, detail: error instanceof Error ? String(error.cause ?? error.message) : String(error) }));
  ipcMain.handle("quitApp", () => app.exit(1));
  try {
    const win = new BrowserWindow({
      width: 520,
      height: 320,
      resizable: false,
      show: false,
      title: t.t("startup.title"),
      backgroundColor: windowBackground(),
      webPreferences: { preload: join(here, "../preload/index.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    harden(win);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => app.exit(1));
    if (DEV_URL) await win.loadURL(`${DEV_URL}#startup`);
    else await win.loadFile(join(here, "../renderer/index.html"), { hash: "startup" });
  } catch {
    dialog.showErrorBox(t.t("startup.title"), t.of(message));
    app.exit(1);
  }
}

function message_(key: Parameters<typeof message>[0], values?: Record<string, string>) {
  return message(key, values);
}

function sendMenu(state: State, command: MenuCommand): void {
  if (command === "records") {
    state.recordsWindow.open();
    return;
  }
  const focused = BrowserWindow.getFocusedWindow();
  // Close in the Records window closes that window; every other command belongs to the main window.
  if (command === "close" && state.recordsWindow.owns(focused)) {
    focused?.close();
    return;
  }
  const win = state.recordsWindow.owns(focused) ? state.window : (focused ?? state.window);
  win?.webContents.send("menu", command);
}

/** Links never navigate a window; a web link opens in the browser. */
function harden(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!navigationAllowed(url, DEV_URL)) event.preventDefault();
  });
}

/** The production renderer enforces a strict policy; the dev server's hot reload needs it relaxed. */
function installCsp(): void {
  if (DEV_URL) return;
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' gptimg-image: data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
  });
}

function createWindow(state: State): void {
  const min = windowMinimum();
  const win = new BrowserWindow({
    name: "main",
    windowStatePersistence: { bounds: true, displayMode: process.platform === "win32" },
    width: INITIAL_WINDOW.width,
    height: INITIAL_WINDOW.height,
    minWidth: min.width,
    minHeight: min.height,
    show: false,
    title: "GptImg",
    backgroundColor: windowBackground(),
    // Windows and Linux paint a window icon; on macOS the bundle's icons own the Dock (app-chrome-conventions).
    ...(process.platform !== "darwin" && { icon: join(process.resourcesPath ?? "", "icon.png") }),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  state.window = win;
  win.once("ready-to-show", () => win.show());
  // The renderer's own failures go to the records, where a bug report can find them.
  win.webContents.on("did-fail-load", (_event, code, description, url) => state.records.log("error", "window.loadFailed", { code, description, url }));
  win.webContents.on("render-process-gone", (_event, details) => state.records.log("error", "window.rendererGone", { ...details }));
  win.webContents.on("console-message", (event) => {
    if (event.level === "warning" || event.level === "error") state.records.log(event.level === "error" ? "error" : "warn", "window.console", { message: event.message, source: event.sourceId, line: event.lineNumber });
  });
  win.webContents.on("preload-error", (_event, path, error) => state.records.log("error", "window.preloadFailed", { path, error: String(error) }));
  win.on("close", (event) => {
    if (!state.quitConfirmed && (state.windowDirty || state.turns.busy || state.exports.busy)) { event.preventDefault(); app.quit(); }
  });
  win.on("query-session-end", () => { state.quitConfirmed = true; });
  win.on("session-end", () => osExit());
  win.on("closed", () => {
    state.window = null;
    // Secondary windows go with the main one.
    state.recordsWindow.close();
  });
  harden(win);
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

function failure(key: Parameters<typeof message>[0], values?: Record<string, string | number>, retryable = false): { ok: false; failure: AppFailure } {
  return { ok: false, failure: { message: message(key, values), retryable } };
}

function chatFailure(error: unknown): { ok: false; failure: AppFailure } {
  if (error instanceof ChatError) {
    if (error.code === "notFound") return failure("failure.chatMissing");
    if (error.code === "malformed") return failure("failure.chatMalformed");
  }
  return failure("failure.chatRead");
}

type Handlers = { [K in keyof GptImgApi]?: (...args: never[]) => unknown };

function installIpc(state: State): void {
  const { paths, keys, records, language } = state;
  let savingUi = false;
  let pendingUi = false;
  const persistUi = async () => {
    if (!state.uiWritable) return;
    pendingUi = true;
    if (savingUi) return;
    savingUi = true;
    try {
      while (pendingUi) {
        pendingUi = false;
        try { await writeTextAtomic(paths.state, json(withHeader("state", { ...state.ui }))); }
        catch (error) { records.log("warn", "state.saveFailed", { error: String(error) }); }
      }
    } finally { savingUi = false; }
  };

  const handlers = {
    async boot(): Promise<BootInfo> {
      return {
        platform: process.platform as BootInfo["platform"],
        version: __APP_VERSION__,
        language: language.info(),
        settings: state.config.settings,
        settingsProblem: state.config.problem,
        settingsLocked: state.config.locked,
        key: await keys.status(),
        state: state.ui,
        suggestedChatsDir: suggestedChatsDir(app.getPath("documents")),
        systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    },

    async saveSettings(next: Settings) {
      if (state.rootChanging) return failure("failure.taskRunning");
      if (next.chatsDir !== state.config.settings.chatsDir && state.turns.busy) return failure("failure.turnRunning");
      if (state.config.locked) return failure("settings.problem.locked", { path: paths.config });
      for (const key of SET_KEYS) {
        const problem = validateSet(key, next[key]);
        if (problem) return failure("failure.settingsInvalid");
      }
      state.rootChanging = next.chatsDir !== state.config.settings.chatsDir;
      try {
      try {
        const text = await saveConfig(paths.config, next, state.config.unknown, state.configExisted);
        if (text) {
          state.configExisted = true;
          state.backups.keep(paths.config, text);
        }
        records.log("info", "settings.saved", { wrote: text !== null });
      } catch (error) {
        records.log("error", "settings.saveFailed", { error: String(error) });
        return failure("failure.settingsWrite");
      }
      const previous = state.config.settings;
      state.config = { ...state.config, settings: next, invalid: [], problem: null };
      if (previous.theme !== next.theme) nativeTheme.themeSource = next.theme;
      if (previous.language !== next.language) {
        await language.use(next.language);
        writeAppleLanguages(next.language, (error) => records.log("warn", "language.appleLanguagesFailed", { error: String(error) }));
      }
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("settingsChanged", next);
      if (previous.chatsDir !== next.chatsDir) state.catalog.folderChanged();
      return { ok: true, settings: next, language: language.info() };
      } finally { state.rootChanging = false; }
    },

    saveState(next: Partial<UiState>) {
      const { recordsListWidth: _recordsOwned, ...patch } = next;
      state.ui = parseUiState({ ...state.ui, ...patch });
      void persistUi();
    },

    async pickFolder(current: string) {
      const owner = state.window;
      const options = {
        title: language.translator.t("dialog.pickChatsFolder"),
        defaultPath: current || suggestedChatsDir(app.getPath("documents")),
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    async keyStatus() {
      return keys.status();
    },
    async peekKey() {
      return (await keys.peek()).value;
    },
    async setKey(value: string) {
      try {
        const problem = await keys.set(value);
        if (problem) return { ok: false, failure: { message: problem, retryable: false } };
        records.log("info", "apiKeys.saved");
      } catch (error) {
        records.log("error", "apiKeys.writeFailed", { error: String(error) });
        return failure("failure.keyWrite");
      }
      return { ok: true, status: await keys.status() };
    },
    async clearKey() {
      try {
        const problem = await keys.clear();
        if (problem) return { ok: false, failure: { message: problem, retryable: false } };
        records.log("info", "apiKeys.cleared");
      } catch (error) {
        records.log("error", "apiKeys.writeFailed", { error: String(error) });
        return failure("failure.keyWrite");
      }
      return { ok: true, status: await keys.status() };
    },

    async listChats() {
      const root = state.config.settings.chatsDir;
      if (!root) return { ok: true, chats: [], unreadable: 0 };
      try {
        return { ok: true, ...(await state.catalog.list(root)) };
      } catch (error) {
        records.log("error", "chats.listFailed", { error: String(error) });
        return failure("failure.chatsFolder", { path: root });
      }
    },
    async openChat(id: string) {
      const root = state.config.settings.chatsDir;
      if (!isChatFolder(id)) return failure("failure.chatMissing");
      try {
        const doc = await readChat(root, id);
        return { ok: true, chat: { id, doc, dir: chatDir(root, id) } };
      } catch (error) {
        return chatFailure(error);
      }
    },
    async renameChat(id: string, title: string) {
      if (state.rootChanging) return failure("failure.taskRunning");
      const root = state.config.settings.chatsDir;
      const clean = title.replace(/\s+/g, " ").trim();
      if (!isChatFolder(id) || !clean) return failure("failure.titleRequired");
      const release = state.turns.reserveChat(id);
      if (!release) return failure("failure.turnRunning");
      try {
        const renamed = await renameChat(root, id, clean);
        state.catalog.change(root, id, summarize(renamed.id, renamed.doc));
        records.log("info", "chats.renamed", { chatId: renamed.doc.id, from: id, to: renamed.id });
        return { ok: true, chat: { id: renamed.id, doc: renamed.doc, dir: chatDir(root, renamed.id) } };
      } catch (error) {
        records.log("error", "chats.renameFailed", { error: String(error) });
        // The title may have been written before the folder rename failed.
        await state.catalog.reread(root, id);
        return chatFailure(error);
      } finally {
        release();
      }
    },
    async trashChat(id: string) {
      if (state.rootChanging) return failure("failure.taskRunning");
      const root = state.config.settings.chatsDir;
      if (!isChatFolder(id)) return failure("failure.chatMissing");
      const release = state.turns.reserveChat(id);
      if (!release) return failure("failure.turnRunning");
      try {
        let chatId = id;
        try {
          chatId = (await readChat(root, id)).id;
        } catch {
          // An unreadable chat is still trashed; its folder name stands in.
        }
        await shell.trashItem(chatDir(root, id));
        state.catalog.change(root, id, null);
        records.log("info", "chats.trashed", { chatId, folder: id });
        return { ok: true };
      } catch (error) {
        records.log("error", "chats.trashFailed", { error: String(error) });
        return failure(process.platform === "darwin" ? "failure.trashMac" : "failure.trashOther");
      } finally {
        release();
      }
    },
    showChatsFolder() {
      const root = state.config.settings.chatsDir;
      if (root) void mkdir(root, { recursive: true }).then(() => shell.openPath(root));
    },
    revealChat(id: string) {
      const root = state.config.settings.chatsDir;
      if (isChatFolder(id)) shell.showItemInFolder(join(chatDir(root, id), "chat.json"));
    },

    async send(request: SendRequest) {
      if (state.rootChanging) return { ...failure("failure.taskRunning"), chat: null, cancelled: false };
      return state.turns.send(request);
    },
    async retry(chatFolder: string) {
      if (state.rootChanging) return { ...failure("failure.taskRunning"), chat: null, cancelled: false };
      return state.turns.retry(chatFolder);
    },
    cancel(chatFolder: string) {
      state.turns.cancel(chatFolder);
    },

    async pickImages() {
      const owner = state.window;
      const options = {
        title: language.translator.t("dialog.pickImages"),
        properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
        filters: [{ name: language.translator.t("dialog.imageFilter"), extensions: [...IMAGE_EXTENSIONS] }],
      };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      const accepted: string[] = [];
      for (const path of result.filePaths) if (await state.images.register(path)) accepted.push(path);
      return accepted;
    },
    async pasteImage() {
      const items = await clipboard.read();
      const item = items.find((entry) => entry.types.includes("image/png"));
      if (!item) return null;
      const blob = (await item.getType("image/png")) as Blob;
      await mkdir(paths.staging, { recursive: true, mode: 0o700 });
      const path = join(paths.staging, `pasted-${randomUUID().slice(0, 8)}.png`);
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()), { flag: "wx", mode: 0o600 });
      await state.images.register(path);
      return path;
    },
    async saveMask(png: Uint8Array) {
      const bytes = png instanceof Uint8Array ? png : null;
      // Only a PNG: the painter's output, checked by its signature.
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (!bytes || !signature.every((b, i) => bytes[i] === b)) return null;
      try {
        await mkdir(paths.staging, { recursive: true, mode: 0o700 });
        const path = join(paths.staging, `mask-${randomUUID().slice(0, 8)}.png`);
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        await state.images.register(path);
        return path;
      } catch (error) {
        state.records.log("warn", "mask.saveFailed", { error: String(error) });
        return null;
      }
    },
    async registerFiles(list: string[]) {
      const accepted: string[] = [];
      for (const path of list) if (typeof path === "string" && isImagePath(path) && (await state.images.register(path))) accepted.push(path);
      return accepted;
    },

    async copyImage(path: string) {
      if (!state.images.allowed(path)) return failure("failure.imageMissing");
      const png = await state.images.png(path);
      if (!png) return failure("failure.imageMissing");
      await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]);
      return { ok: true };
    },
    async inspectImage(path: string) {
      if (!state.images.allowed(path)) return failure("failure.imageMissing");
      const outcome = await state.exports.inspect(path);
      return outcome.ok ? { ok: true, info: outcome.value } : { ok: false, failure: outcome.failure };
    },
    upscalerStatus() {
      return state.exports.upscalerStatus();
    },
    async installUpscaler() {
      const outcome = await state.exports.installUpscaler();
      return outcome.ok ? { ok: true } : { ok: false, failure: outcome.failure };
    },
    async exportImage(request: ExportRequest, suggestedName: string): Promise<Outcome<{ savedTo: string | null; dir: string | null }>> {
      if (!state.images.allowed(request.path)) return failure("failure.imageMissing");
      const inspected = await state.exports.inspect(request.path);
      if (!inspected.ok) return { ok: false, failure: inspected.failure };
      const t = language.translator;
      const owner = state.window;
      const ext = extensionOf(request.format);
      const folder = state.ui.exportDir ?? app.getPath("downloads");
      const options = {
        title: t.t("dialog.exportImage"),
        defaultPath: join(folder, suggestedName.replace(/[\\/]/g, "-")),
        filters: [{ name: t.t(`export.format.${request.format}`), extensions: request.format === "jpeg" ? ["jpg", "jpeg"] : [ext] }],
      };
      const chosen = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (chosen.canceled || !chosen.filePath) return { ok: true, savedTo: null, dir: null };
      const outcome = await state.exports.export(request, inspected.value, chosen.filePath);
      if (!outcome.ok) return { ok: false, failure: outcome.cancelled ? { message: message("failure.cancelled"), retryable: true } : outcome.failure };
      return { ok: true, savedTo: outcome.value, dir: folderOf(outcome.value) };
    },
    cancelTask() {
      state.exports.cancel();
    },
    async showInFolder(path: string) {
      if (state.images.allowed(path)) shell.showItemInFolder(path);
    },

    openRecords() {
      state.recordsWindow.open();
    },
    recordLaunches() {
      return records.launches();
    },
    async recordChats() {
      const root = state.config.settings.chatsDir;
      if (!root) return [];
      try {
        // The listing main already holds, with each chat's lasting id.
        return (await state.catalog.list(root)).chats.map((row) => ({ id: row.chatId, title: row.title }));
      } catch {
        return [];
      }
    },
    queryRecords(query: RecordQuery) {
      return records.query(query);
    },
    recordDetail(ref: RecordRef) {
      return records.detail(ref);
    },
    saveRecordsLayout(listWidth: number) {
      state.ui = parseUiState({ ...state.ui, recordsListWidth: listWidth });
      void persistUi();
    },

    setWindowDirty(dirty: boolean) { state.windowDirty = dirty; },
    closeWindow() {
      (BrowserWindow.getFocusedWindow() ?? state.window)?.close();
    },
  } satisfies Handlers;

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(name, (_event, ...args: unknown[]) => (handler as (...a: unknown[]) => unknown)(...args));
  }
}
