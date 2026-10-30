// What a renderer test needs: the bridge the window would get from preload,
// as stubs a test can script, and the i18n provider in English.
import { configure, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { BootInfo, GptImgApi, LanguageInfo } from "../../src/shared/api.ts";
import { builtInSettings } from "../../src/shared/settings.ts";
import { defaultUiState } from "../../src/shared/ui-state.ts";
import { ENGLISH } from "../../src/shared/i18n/catalogues.ts";

export const language: LanguageInfo = { language: "en", locale: "en-US", systemLanguage: "en", catalogue: ENGLISH };

// Tests carry no timeouts: a findBy or waitFor ends when the screen shows what it
// waits for, so Testing Library's one-second limit is lifted to the longest a timer allows.
configure({ asyncUtilTimeout: 2 ** 31 - 1 });

const noop = () => () => {};

export function fakeApi(over: Partial<GptImgApi> = {}): GptImgApi {
  const api = {
    onLanguage: noop,
    onMenu: noop,
    onTurnStarted: noop,
    onSessionsChanged: noop,
    onProgress: noop,
    registerFiles: vi.fn(async (paths: string[]) => paths),
    pickImages: vi.fn(async () => []),
    pasteImage: vi.fn(async () => null),
    pathForFile: () => "",
    inspectImage: vi.fn(async () => ({ ok: true, info: { width: 1024, height: 1024, format: "png", fileBytes: 2_000_000, transparent: true } })),
    upscalerStatus: vi.fn(async () => ({ installed: false, downloadBytes: 53_827_735 })),
    installUpscaler: vi.fn(async () => ({ ok: true })),
    exportImage: vi.fn(async () => ({ ok: true, savedTo: "/out/a.jpg", dir: "/out" })),
    cancelTask: vi.fn(),
    queryRecords: vi.fn(async () => ({ rows: [], next: null, failed: false })),
    recordDetail: vi.fn(async () => null),
    recordLaunches: vi.fn(async () => []),
    recordChats: vi.fn(async () => []),
    saveRecordsLayout: vi.fn(),
    onRecordsChanged: noop,
    openRecords: vi.fn(),
    showChatsFolder: vi.fn(),
    peekKey: vi.fn(async () => "sk-saved"),
    saveSettings: vi.fn(async (settings: unknown) => ({ ok: true, settings, language })),
    setKey: vi.fn(async () => ({ ok: true, status: { source: "stored", problem: null } })),
    clearKey: vi.fn(async () => ({ ok: true, status: { source: "none", problem: null } })),
    pickFolder: vi.fn(async () => null),
    copyImage: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  (window as unknown as { gptimg: unknown }).gptimg = api;
  return api as unknown as GptImgApi;
}

export function bootInfo(): BootInfo {
  return {
    platform: "darwin",
    version: "0.0.0",
    language,
    settings: { ...builtInSettings(), sessionsDir: "/chats" },
    settingsProblem: null,
    settingsLocked: false,
    key: { source: "stored", problem: null },
    state: defaultUiState(),
    suggestedSessionsDir: "/Users/x/Documents/GptImg",
    systemTimeZone: "UTC",
  };
}

export async function renderInApp(element: () => ReactElement) {
  const { I18nProvider } = await import("../../src/renderer/src/i18n.tsx");
  return render(<I18nProvider initial={language}>{element()}</I18nProvider>);
}
