// GptImg's main process: settles storage, language and theme before any
// window exists, owns every store, and answers the window's requests.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell } from "electron";
import type { AppFailure, BootInfo, GptImgApi, MenuCommand, Outcome, SendRequest } from "../shared/api.ts";
import { message } from "../shared/i18n/translator.ts";
import { INITIAL_WINDOW, windowMinimum } from "../shared/layout.ts";
import { SET_KEYS, validateSet, type Settings } from "../shared/settings.ts";
import { parseUiState, type UiState } from "../shared/ui-state.ts";
import { KeyStore } from "./api-keys.ts";
import { openBackups, type Backups } from "./backups.ts";
import { loadConfig, saveConfig, type LoadedConfig } from "./config.ts";
import { json, readText, writeTextAtomic } from "./files.ts";
import { ImageAccess, isImagePath, registerImageScheme, REFERENCE_EXTENSIONS } from "./images.ts";
import { chromiumLang, clearAppleLanguages, earlyPreferences, LanguageOwner, writeAppleLanguages } from "./language.ts";
import { buildMenu } from "./menu.ts";
import { DataDirError, ensureDataRoot, suggestedSessionsDir, type AppPaths } from "./paths.ts";
import { openRecords, type Records } from "./records.ts";
import { SdkHost } from "./sdk-host.ts";
import { isSessionId, listSessions, readSession, renameSession, SessionError, sessionDir } from "./sessions.ts";
import { TurnRunner } from "./turns.ts";

declare const __APP_VERSION__: string;

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const here = fileURLToPath(new URL(".", import.meta.url));

app.setName("GptImg");
registerImageScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start();
}

interface State {
  paths: AppPaths;
  config: LoadedConfig;
  configExisted: boolean;
  ui: UiState;
  keys: KeyStore;
  records: Records;
  backups: Backups;
  language: LanguageOwner;
  host: SdkHost;
  turns: TurnRunner;
  images: ImageAccess;
  window: BrowserWindow | null;
  quitConfirmed: boolean;
}

async function start(): Promise<void> {
  // Storage first: an unusable folder stops the app with a message, before anything else.
  let paths: AppPaths;
  try {
    paths = ensureDataRoot();
  } catch (error) {
    await app.whenReady();
    const language = new LanguageOwner();
    language.readComputer();
    await language.use("system");
    const t = language.translator;
    const dir = error instanceof DataDirError ? error.dir : "";
    dialog.showErrorBox(t.t("startup.storageTitle"), t.t(error instanceof DataDirError && error.fromEnv ? "startup.storageEnv" : "startup.storage", { path: dir }));
    app.exit(1);
    return;
  }

  const early = earlyPreferences(paths.config);
  const lang = chromiumLang(early.language);
  if (lang) app.commandLine.appendSwitch("lang", lang);

  await app.whenReady();

  const launchId = randomUUID();
  const records = openRecords(paths.records, launchId, __APP_VERSION__);
  const backups = openBackups(paths.backups, launchId, (error) => records.log("warn", "backups.failed", { error: String(error) }));
  records.log("info", "app.start", { version: __APP_VERSION__, platform: process.platform, dataDir: paths.root });

  const language = new LanguageOwner();
  clearAppleLanguages((error) => records.log("warn", "language.appleLanguagesFailed", { error: String(error) }));
  language.readComputer();

  const configRead = await readText(paths.config);
  const config = await loadConfig(paths.config);
  await language.use(config.settings.language);
  writeAppleLanguages(config.settings.language, (error) => records.log("warn", "language.appleLanguagesFailed", { error: String(error) }));
  nativeTheme.themeSource = config.settings.theme;
  if (config.problem) records.log("warn", "settings.loadProblem", { problem: config.problem });

  const stateRead = await readText(paths.state);
  let ui = parseUiState(null);
  if (stateRead.kind === "ok") {
    try {
      ui = parseUiState(JSON.parse(stateRead.text));
    } catch {
      // Window and pane state is disposable: a bad copy is dropped.
    }
  }

  // Pasted images from an earlier launch that were never sent.
  await rm(paths.staging, { recursive: true, force: true }).catch(() => {});

  const keys = new KeyStore(paths.apiKeys, process.env, (event, fields) => records.log("warn", event, fields));
  const host = new SdkHost(join(here, "sdk-worker.js"), (code) => records.log(code === 0 ? "info" : "error", "sdk.workerExit", { code }));

  const state: State = {
    paths,
    config,
    configExisted: configRead.kind !== "absent",
    ui,
    keys,
    records,
    backups,
    language,
    host,
    turns: null as unknown as TurnRunner,
    images: new ImageAccess(() => [state.config.settings.sessionsDir, paths.staging]),
    window: null,
    quitConfirmed: false,
  };
  state.turns = new TurnRunner({
    host,
    records,
    settings: () => state.config.settings,
    apiKey: () => keys.resolve(),
    app: { name: "GptImg", version: __APP_VERSION__ },
    backup: (path, text) => backups.keep(path, text),
    started: (requestId, session) => state.window?.webContents.send("turnStarted", { requestId, session }),
    releaseStaged: (path) => {
      if (path.startsWith(paths.staging)) void rm(path, { force: true });
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
    state.window?.webContents.send("language", info);
  });

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
  app.on("before-quit", (event) => {
    // One quit owner: a reply still on its way is the only thing a quit can lose.
    if (state.quitConfirmed || !state.turns.busy) {
      state.turns.cancelAll();
      return;
    }
    event.preventDefault();
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
      if (response !== 1) return;
      state.quitConfirmed = true;
      state.turns.cancelAll();
      app.quit();
    });
  });
  app.on("will-quit", () => {
    host.stop();
    records.log("info", "app.quit");
    records.close();
    backups.close();
  });
}

function sendMenu(state: State, command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? state.window;
  win?.webContents.send("menu", command);
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141517" : "#f6f3ee",
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
  win.on("closed", () => {
    state.window = null;
  });
  // Links never navigate the window; a web link opens in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!DEV_URL || !url.startsWith(DEV_URL)) event.preventDefault();
  });
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

function failure(key: Parameters<typeof message>[0], values?: Record<string, string | number>, retryable = false): { ok: false; failure: AppFailure } {
  return { ok: false, failure: { message: message(key, values), retryable } };
}

function sessionFailure(error: unknown): { ok: false; failure: AppFailure } {
  if (error instanceof SessionError) {
    if (error.code === "notFound") return failure("failure.sessionMissing");
    if (error.code === "malformed") return failure("failure.sessionMalformed");
  }
  return failure("failure.sessionRead");
}

type Handlers = { [K in keyof GptImgApi]?: (...args: never[]) => unknown };

function installIpc(state: State): void {
  const { paths, keys, records, language } = state;

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
        suggestedSessionsDir: suggestedSessionsDir(app.getPath("documents")),
        systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    },

    async saveSettings(next: Settings) {
      if (state.config.locked) return failure("settings.problem.locked", { path: paths.config });
      for (const key of SET_KEYS) {
        const problem = validateSet(key, next[key]);
        if (problem) return failure("failure.settingsInvalid");
      }
      try {
        const text = await saveConfig(paths.config, next, state.config.unknown, state.configExisted);
        if (text) {
          state.configExisted = true;
          state.backups.keep(paths.config, text);
        }
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
      return { ok: true, settings: next, language: language.info() };
    },

    saveState(next: UiState) {
      state.ui = parseUiState(next);
      void writeTextAtomic(paths.state, json(state.ui)).catch((error) => records.log("warn", "state.saveFailed", { error: String(error) }));
    },

    async pickFolder(current: string) {
      const owner = state.window;
      const options = {
        title: language.translator.t("dialog.pickSessionsFolder"),
        defaultPath: current || suggestedSessionsDir(app.getPath("documents")),
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
      } catch (error) {
        records.log("error", "apiKeys.writeFailed", { error: String(error) });
        return failure("failure.keyWrite");
      }
      return { ok: true, status: await keys.status() };
    },

    async listSessions() {
      const root = state.config.settings.sessionsDir;
      if (!root) return { ok: true, sessions: [], unreadable: 0 };
      try {
        return { ok: true, ...(await listSessions(root)) };
      } catch (error) {
        records.log("error", "sessions.listFailed", { error: String(error) });
        return failure("failure.sessionsFolder", { path: root });
      }
    },
    async openSession(id: string) {
      const root = state.config.settings.sessionsDir;
      if (!isSessionId(id)) return failure("failure.sessionMissing");
      try {
        const doc = await readSession(root, id);
        return { ok: true, session: { id, doc, dir: sessionDir(root, id) } };
      } catch (error) {
        return sessionFailure(error);
      }
    },
    async renameSession(id: string, title: string) {
      const root = state.config.settings.sessionsDir;
      const clean = title.replace(/\s+/g, " ").trim();
      if (!isSessionId(id) || !clean) return failure("failure.titleRequired");
      if (state.turns.isRunning(id)) return failure("failure.turnRunning");
      try {
        const renamed = await renameSession(root, id, clean);
        return { ok: true, session: { id: renamed.id, doc: renamed.doc, dir: sessionDir(root, renamed.id) } };
      } catch (error) {
        records.log("error", "sessions.renameFailed", { error: String(error) });
        return sessionFailure(error);
      }
    },
    async trashSession(id: string) {
      const root = state.config.settings.sessionsDir;
      if (!isSessionId(id)) return failure("failure.sessionMissing");
      if (state.turns.isRunning(id)) return failure("failure.turnRunning");
      try {
        await shell.trashItem(sessionDir(root, id));
        records.log("info", "sessions.trashed", { id });
        return { ok: true };
      } catch (error) {
        records.log("error", "sessions.trashFailed", { error: String(error) });
        return failure(process.platform === "darwin" ? "failure.trashMac" : "failure.trashOther");
      }
    },
    revealSession(id: string) {
      const root = state.config.settings.sessionsDir;
      if (isSessionId(id)) shell.showItemInFolder(join(sessionDir(root, id), "session.json"));
    },

    send(request: SendRequest) {
      return state.turns.send(request);
    },
    retry(sessionId: string) {
      return state.turns.retry(sessionId);
    },
    cancel(sessionId: string) {
      state.turns.cancel(sessionId);
    },

    async pickImages() {
      const owner = state.window;
      const options = {
        title: language.translator.t("dialog.pickImages"),
        properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
        filters: [{ name: language.translator.t("dialog.imageFilter"), extensions: REFERENCE_EXTENSIONS.map((ext) => ext.slice(1)) }],
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
    async registerFiles(list: string[]) {
      const accepted: string[] = [];
      for (const path of list) if (typeof path === "string" && isImagePath(path) && (await state.images.register(path))) accepted.push(path);
      return accepted;
    },

    async copyImage(path: string) {
      if (!state.images.allowed(path)) return failure("failure.imageMissing");
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) return failure("failure.imageMissing");
      await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
      return { ok: true };
    },
    async exportImage(path: string): Promise<Outcome<{ savedTo: string | null }>> {
      if (!state.images.allowed(path)) return failure("failure.imageMissing");
      const owner = state.window;
      const name = path.split(/[\\/]/).pop() ?? "image.png";
      const options = { title: language.translator.t("dialog.exportImage"), defaultPath: join(app.getPath("downloads"), name) };
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { ok: true, savedTo: null };
      try {
        await copyFile(path, result.filePath);
        return { ok: true, savedTo: result.filePath };
      } catch (error) {
        records.log("error", "image.exportFailed", { error: String(error) });
        return failure("failure.exportFailed");
      }
    },
    showInFolder(path: string) {
      if (state.images.allowed(path)) shell.showItemInFolder(path);
    },

    closeWindow() {
      (BrowserWindow.getFocusedWindow() ?? state.window)?.close();
    },
  } satisfies Handlers;

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(name, (_event, ...args: unknown[]) => (handler as (...a: unknown[]) => unknown)(...args));
  }
}
