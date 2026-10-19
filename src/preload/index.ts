// The window's only door to main: each method is one IPC call, typed by the
// shared interface it satisfies.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { GptImgApi, LanguageInfo, MenuCommand, OpenedSession } from "../shared/api.ts";

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
  send: invoke("send"),
  retry: invoke("retry"),
  cancel: fire("cancel"),
  pickImages: invoke("pickImages"),
  pasteImage: invoke("pasteImage"),
  registerFiles: invoke("registerFiles"),
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  copyImage: invoke("copyImage"),
  exportImage: invoke("exportImage"),
  showInFolder: fire("showInFolder"),
  closeWindow: fire("closeWindow"),
  onMenu: (handler: (command: MenuCommand) => void) => {
    const listener = (_event: unknown, command: MenuCommand) => handler(command);
    ipcRenderer.on("menu", listener);
    return () => ipcRenderer.off("menu", listener);
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
} satisfies GptImgApi;

contextBridge.exposeInMainWorld("gptimg", api);
