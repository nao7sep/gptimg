// What the app remembers about its own surface between launches (state.json):
// not settings, so it is written freely and a bad copy is simply dropped.
import { defaultExportPrefs, parseExportPrefs, type ExportPrefs } from "./export.ts";
import { BACKGROUNDS, type TurnOptions } from "./chat.ts";

export interface UiState {
  /** The rail's width as the user last dragged it; null until they drag. */
  railWidth: number | null;
  lastChatId: string | null;
  /** The composer's shape and quality, as last sent. */
  composer: TurnOptions;
  /** The export dialog's choices, as last used. */
  export: ExportPrefs;
  /** The folder the last export went to. */
  exportDir: string | null;
  /** The Records window's list width as the user last dragged it. */
  recordsListWidth: number | null;
  /** Whether the chat's images show beside the conversation. */
  imagesPane: boolean;
}

export const RECORDS_LIST_WIDTH = { min: 300, max: 720, initial: 420 } as const;

export const RAIL_WIDTH = { min: 200, max: 420, initial: 264 } as const;

export const SIZES = ["auto", "1024x1024", "1024x1536", "1536x1024"] as const;
export const QUALITIES = ["auto", "low", "medium", "high"] as const;

export function defaultUiState(): UiState {
  return { railWidth: null, lastChatId: null, composer: { size: "auto", quality: "auto" }, export: defaultExportPrefs(), exportDir: null, recordsListWidth: null, imagesPane: true };
}

export function parseUiState(value: unknown): UiState {
  const base = defaultUiState();
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;
  const width = raw.railWidth;
  const railWidth =
    typeof width === "number" && Number.isFinite(width) ? Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, Math.round(width))) : null;
  const lastChatId = typeof raw.lastChatId === "string" ? raw.lastChatId : null;
  const composer = raw.composer as Record<string, unknown> | undefined;
  const size = typeof composer?.size === "string" ? composer.size : base.composer.size;
  const quality = typeof composer?.quality === "string" ? composer.quality : base.composer.quality;
  const background = BACKGROUNDS.find((b) => b !== "auto" && composer?.background === b);
  const exportDir = typeof raw.exportDir === "string" && raw.exportDir !== "" ? raw.exportDir : null;
  const listWidth = raw.recordsListWidth;
  const recordsListWidth =
    typeof listWidth === "number" && Number.isFinite(listWidth)
      ? Math.min(RECORDS_LIST_WIDTH.max, Math.max(RECORDS_LIST_WIDTH.min, Math.round(listWidth)))
      : null;
  return { railWidth, lastChatId, composer: { size, quality, ...(background && background !== "auto" && { background }) }, export: parseExportPrefs(raw.export), exportDir, recordsListWidth, imagesPane: raw.imagesPane !== false };
}
