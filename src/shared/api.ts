// The bridge between the window and main, declared here so preload implements
// it with `satisfies` and the renderer imports nothing from the Node side.
import type { ExportRequest, ImageInfo } from "./export.ts";
import type { LaunchEntry, RecordDetail, RecordQuery, RecordRef, RecordsPage } from "./records.ts";
import type { Catalogue } from "./i18n/catalogues.ts";
import type { Language } from "./i18n/languages.ts";
import type { Message } from "./i18n/translator.ts";
import type { SessionChange, SessionDoc, SessionSummary, TurnOptions } from "./session.ts";
import type { Settings } from "./settings.ts";
import type { UiState } from "./ui-state.ts";

export type Platform = "darwin" | "win32" | "linux";

export interface LanguageInfo {
  language: Language;
  locale: string;
  /** The language System resolves to, so the picker can name it. */
  systemLanguage: Language;
  catalogue: Catalogue;
}

export type KeySource = "env" | "stored" | "none";

export interface KeyStatus {
  source: KeySource;
  /** Why the stored key could not be read, when it could not. */
  problem: Message | null;
}

export interface BootInfo {
  platform: Platform;
  version: string;
  language: LanguageInfo;
  settings: Settings;
  /** A settings problem found at load (invalid sets fell back, or the file is unreadable). */
  settingsProblem: Message | null;
  /** True when config.json could not be read: Save is held so nothing overwrites it. */
  settingsLocked: boolean;
  key: KeyStatus;
  state: UiState;
  /** The folder sessions live in by default, offered at first run. */
  suggestedSessionsDir: string;
  /** The zone "system" means on this computer. */
  systemTimeZone: string;
}

/** A failure the renderer shows: the app's own text, and the provider's safe reason beneath it when there is one. */
export interface AppFailure {
  message: Message;
  reason?: string;
  /** Owned inputs or a delivered reply remain here after a save failure. */
  recoveryPath?: string;
  /** True when trying again could help (the provider or the network, not the input). */
  retryable: boolean;
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; failure: AppFailure };

export interface SessionsListing {
  sessions: SessionSummary[];
  /** Folders in the sessions folder that hold no readable session.json. */
  unreadable: number;
}

export interface OpenedSession {
  id: string;
  doc: SessionDoc;
  /** The absolute folder, for building image URLs and reveal. */
  dir: string;
}

export interface SendRequest {
  /** The window's own token for this send, echoed by `onTurnStarted`. */
  requestId: string;
  /** Null starts a new session with this message. */
  sessionId: string | null;
  text: string;
  /** Absolute paths of attached images (registered through `attach.*`) or session-relative paths. */
  references: string[];
  /** A painted mask (an absolute staged path) for one of `references`, which is sent first. */
  mask?: { image: string; mask: string };
  options: TurnOptions;
}

/** A turn's end: the session as it now stands, with the failure when the reply did not come. */
export type TurnOutcome =
  | { ok: true; session: OpenedSession }
  | { ok: false; session: OpenedSession | null; failure: AppFailure; cancelled: boolean };

/** A long local task's progress: an export (its upscale passes) or the upscaling model's download. */
export interface TaskProgress {
  task: "export" | "install";
  stage: string;
  done: number;
  total: number;
  unit: string;
}

export interface UpscalerStatus {
  installed: boolean;
  /** The model status could not be checked; this does not mean it is absent. */
  failure?: AppFailure;
  /** What installing it downloads, in bytes, when known. */
  downloadBytes: number | null;
}

export type MenuCommand = "newSession" | "settings" | "shortcuts" | "about" | "records" | "attach" | "close" | "rename" | "reveal" | "trash";

export interface StartupFailure {
  language: LanguageInfo;
  message: Message;
  /** The system's own words for the cause, shown under Details. */
  detail: string;
}

export interface GptImgApi {
  boot(): Promise<BootInfo>;
  /** Only in the startup-failure window: why GptImg could not start. */
  startupFailure(): Promise<StartupFailure>;
  quitApp(): void;
  saveSettings(next: Settings): Promise<Outcome<{ settings: Settings; language: LanguageInfo }>>;
  saveState(state: Partial<UiState>): void;
  pickFolder(current: string): Promise<string | null>;

  keyStatus(): Promise<KeyStatus>;
  peekKey(): Promise<string | null>;
  setKey(value: string): Promise<Outcome<{ status: KeyStatus }>>;
  clearKey(): Promise<Outcome<{ status: KeyStatus }>>;

  listSessions(): Promise<Outcome<SessionsListing>>;
  openSession(id: string): Promise<Outcome<{ session: OpenedSession }>>;
  renameSession(id: string, title: string): Promise<Outcome<{ session: OpenedSession }>>;
  trashSession(id: string): Promise<Outcome<object>>;
  revealSession(id: string): void;
  /** Opens the chats folder in Finder or Explorer. */
  showChatsFolder(): void;

  send(request: SendRequest): Promise<TurnOutcome>;
  retry(sessionId: string): Promise<TurnOutcome>;
  cancel(sessionId: string): void;

  /** Native picker for reference images; the chosen paths are registered for preview. */
  pickImages(): Promise<string[]>;
  /** The clipboard's image saved to a staging file, or null when it holds none. */
  pasteImage(): Promise<string | null>;
  /** A painted mask's PNG saved to a staging file, or null when it could not be saved. */
  saveMask(png: Uint8Array): Promise<string | null>;
  /** Registers dropped files: returns the ones that are images the SDK can read. */
  registerFiles(paths: string[]): Promise<string[]>;
  /** The path of a dropped File (Electron's webUtils), "" when it has none. */
  pathForFile(file: File): string;

  copyImage(path: string): Promise<Outcome<object>>;
  inspectImage(path: string): Promise<Outcome<{ info: ImageInfo }>>;
  upscalerStatus(): Promise<UpscalerStatus>;
  /** Downloads the upscaling model, on the user's request only. */
  installUpscaler(): Promise<Outcome<object>>;
  /** Asks where to save (`suggestedName` in the last export folder), then makes the file. Null `savedTo` when the user cancelled the save dialog. */
  exportImage(request: ExportRequest, suggestedName: string): Promise<Outcome<{ savedTo: string | null; dir: string | null }>>;
  /** Stops the running export or download. */
  cancelTask(): void;
  onProgress(handler: (progress: TaskProgress) => void): () => void;
  showInFolder(path: string): void;

  /** Opens the Records window, or brings it forward. */
  openRecords(): void;
  recordLaunches(): Promise<LaunchEntry[]>;
  /** The chats in the chats folder, by lasting id, for the Records window's chat filter. */
  recordChats(): Promise<{ id: string; title: string }[]>;
  queryRecords(query: RecordQuery): Promise<RecordsPage>;
  recordDetail(ref: RecordRef): Promise<RecordDetail | null>;
  saveRecordsLayout(listWidth: number): void;
  /** A record was stored (at most once a second): the Records window refreshes. */
  onRecordsChanged(handler: () => void): () => void;

  setWindowDirty(dirty: boolean): void;
  closeWindow(): void;
  onMenu(handler: (command: MenuCommand) => void): () => void;
  onSettings(handler: (settings: Settings) => void): () => void;
  /** One session was added, saved, renamed or trashed, or the sessions folder changed. */
  onSessionsChanged(handler: (change: SessionChange) => void): () => void;
  onLanguage(handler: (info: LanguageInfo) => void): () => void;
  /** The user's turn is saved and the call has started: the session as it now stands. */
  onTurnStarted(handler: (event: { requestId: string; session: OpenedSession }) => void): () => void;
  /** The latest draft of the image a chat's turn is drawing, or null once the turn settles. */
  onTurnDraft(handler: (event: { sessionId: string; path: string | null }) => void): () => void;
}

/** The URL the renderer loads an image through; `width` asks main for a copy decoded at that size. */
export function imageUrl(path: string, width?: number): string {
  const encoded = encodeURIComponent(path);
  return `gptimg-image://local/${encoded}${width ? `?w=${Math.round(width)}` : ""}`;
}

export const IMAGE_SCHEME = "gptimg-image";
