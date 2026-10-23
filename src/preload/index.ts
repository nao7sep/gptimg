// The window's only door to main: each method is one IPC call, typed by the
// shared interface it satisfies.
import type { Settings } from "../shared/settings.ts";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { GptImgApi, LanguageInfo, MenuCommand, OpenedSession, TaskProgress } from "../shared/api.ts";

const invoke =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(name, ...args);

const fire =
  (name: string) =>
  (...args: unknown[]) => {
    void ipcRenderer.invoke(name, ...args);
  };

const api = {
  boot: invoke("boot"),
  startupFailure: invoke("startupFailure"),
  quitApp: fire("quitApp"),
  saveSettings: invoke("saveSettings"),
  saveState: fire("saveState"),
  pickFolder: invoke("pickFolder"),
  keyStatus: invoke("keyStatus"),
  peekKey: invoke("peekKey"),
  setKey: invoke("setKey"),
  clearKey: invoke("clearKey"),
  listSessions: invoke("listSessions"),
  openSession: invoke("openSession"),
  renameSession: invoke("renameSession"),
  trashSession: invoke("trashSession"),
  revealSession: fire("revealSession"),
  showChatsFolder: fire("showChatsFolder"),
  send: invoke("send"),
  retry: invoke("retry"),
  cancel: fire("cancel"),
  restartProcessing: invoke("restartProcessing"),
  pickImages: invoke("pickImages"),
  pasteImage: invoke("pasteImage"),
  saveMask: invoke("saveMask"),
  registerFiles: invoke("registerFiles"),
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  copyImage: invoke("copyImage"),
  inspectImage: invoke("inspectImage"),
  upscalerStatus: invoke("upscalerStatus"),
  installUpscaler: invoke("installUpscaler"),
  exportImage: invoke("exportImage"),
  cancelTask: fire("cancelTask"),
  onProgress: (handler: (progress: TaskProgress) => void) => {
    const listener = (_event: unknown, progress: TaskProgress) => handler(progress);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.off("progress", listener);
  },
  showInFolder: fire("showInFolder"),
  openRecords: fire("openRecords"),
  recordLaunches: invoke("recordLaunches"),
  recordChats: invoke("recordChats"),
  queryRecords: invoke("queryRecords"),
  recordDetail: invoke("recordDetail"),
  saveRecordsLayout: fire("saveRecordsLayout"),
  onRecordsChanged: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("recordsChanged", listener);
    return () => ipcRenderer.off("recordsChanged", listener);
  },
  setWindowDirty: fire("setWindowDirty"),
  closeWindow: fire("closeWindow"),
  onMenu: (handler: (command: MenuCommand) => void) => {
    const listener = (_event: unknown, command: MenuCommand) => handler(command);
    ipcRenderer.on("menu", listener);
    return () => ipcRenderer.off("menu", listener);
  },
  onSettings: (handler: (settings: Settings) => void) => {
    const listener = (_event: unknown, settings: Settings) => handler(settings);
    ipcRenderer.on("settingsChanged", listener);
    return () => ipcRenderer.off("settingsChanged", listener);
  },
  onSessionsChanged: (handler: () => void) => {
    ipcRenderer.on("sessionsChanged", handler);
    return () => ipcRenderer.off("sessionsChanged", handler);
  },
  onLanguage: (handler: (info: LanguageInfo) => void) => {
    const listener = (_event: unknown, info: LanguageInfo) => handler(info);
    ipcRenderer.on("language", listener);
    return () => ipcRenderer.off("language", listener);
  },
  onTurnStarted: (handler: (event: { requestId: string; session: OpenedSession }) => void) => {
    const listener = (_event: unknown, payload: { requestId: string; session: OpenedSession }) => handler(payload);
    ipcRenderer.on("turnStarted", listener);
    return () => ipcRenderer.off("turnStarted", listener);
  },
  onTurnDraft: (handler: (event: { sessionId: string; path: string | null }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string; path: string | null }) => handler(payload);
    ipcRenderer.on("turnDraft", listener);
    return () => ipcRenderer.off("turnDraft", listener);
  },
} satisfies GptImgApi;

contextBridge.exposeInMainWorld("gptimg", api);
