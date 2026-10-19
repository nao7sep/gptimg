// The bridge between the window and main, declared here so preload implements
// it with `satisfies` and the renderer imports nothing from the Node side.
import type { Catalogue } from "./i18n/catalogues.ts";
import type { Language } from "./i18n/languages.ts";
import type { Message } from "./i18n/translator.ts";
import type { SessionDoc, SessionSummary, TurnOptions } from "./session.ts";
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
  options: TurnOptions;
}

/** A turn's end: the session as it now stands, with the failure when the reply did not come. */
export type TurnOutcome =
  | { ok: true; session: OpenedSession }
  | { ok: false; session: OpenedSession | null; failure: AppFailure; cancelled: boolean };

export type MenuCommand = "newSession" | "settings" | "shortcuts" | "about" | "attach" | "close" | "rename" | "reveal" | "trash";

export interface GptImgApi {
  boot(): Promise<BootInfo>;
  saveSettings(next: Settings): Promise<Outcome<{ settings: Settings; language: LanguageInfo }>>;
  saveState(state: UiState): void;
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

  send(request: SendRequest): Promise<TurnOutcome>;
  retry(sessionId: string): Promise<TurnOutcome>;
  cancel(sessionId: string): void;

  /** Native picker for reference images; the chosen paths are registered for preview. */
  pickImages(): Promise<string[]>;
  /** The clipboard's image saved to a staging file, or null when it holds none. */
  pasteImage(): Promise<string | null>;
  /** Registers dropped files: returns the ones that are images the SDK can read. */
  registerFiles(paths: string[]): Promise<string[]>;
  /** The path of a dropped File (Electron's webUtils), "" when it has none. */
  pathForFile(file: File): string;

  copyImage(path: string): Promise<Outcome<object>>;
  exportImage(path: string): Promise<Outcome<{ savedTo: string | null }>>;
  showInFolder(path: string): void;

  closeWindow(): void;
  onMenu(handler: (command: MenuCommand) => void): () => void;
  onLanguage(handler: (info: LanguageInfo) => void): () => void;
  /** The user's turn is saved and the call has started: the session as it now stands. */
  onTurnStarted(handler: (event: { requestId: string; session: OpenedSession }) => void): () => void;
}

/** The URL the renderer loads an image through; `width` asks main for a copy decoded at that size. */
export function imageUrl(path: string, width?: number): string {
  const encoded = encodeURIComponent(path);
  return `gptimg-image://local/${encoded}${width ? `?w=${Math.round(width)}` : ""}`;
}

export const IMAGE_SCHEME = "gptimg-image";
