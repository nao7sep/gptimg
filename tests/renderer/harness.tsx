// What a renderer test needs: the bridge the window would get from preload,
// as stubs a test can script, and the i18n provider in English.
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { GptImgApi, LanguageInfo } from "../../src/shared/api.ts";
import { ENGLISH } from "../../src/shared/i18n/catalogues.ts";

export const language: LanguageInfo = { language: "en", locale: "en-US", systemLanguage: "en", catalogue: ENGLISH };

const noop = () => () => {};

export function fakeApi(over: Partial<GptImgApi> = {}): GptImgApi {
  const api = {
    onLanguage: noop,
    onMenu: noop,
    onTurnStarted: noop,
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
    queryRecords: vi.fn(async () => ({ rows: [], more: false, unavailable: false })),
    recordDetail: vi.fn(async () => null),
    copyImage: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  (window as unknown as { gptimg: unknown }).gptimg = api;
  return api as unknown as GptImgApi;
}

export async function renderInApp(element: () => ReactElement) {
  const { I18nProvider } = await import("../../src/renderer/src/i18n.tsx");
  return render(<I18nProvider initial={language}>{element()}</I18nProvider>);
}
