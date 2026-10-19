// A session as it is kept in its folder's session.json, and the pure rules
// around it: naming, titles, the history a turn sends, token totals.

export const SESSION_FORMAT = 1;
export const SESSION_FILE = "session.json";
export const INPUTS_DIR = "inputs";

/** The image choices a user turn was sent with. */
export interface TurnOptions {
  /** "auto" or "<w>x<h>". */
  size: string;
  quality: string;
  /** Ask the image model for a transparent background; absent, the model decides. */
  transparent?: boolean;
}

/** A turn's tokens: the assistant model's, and the image tool's apart, since the two are billed at different rates. */
export interface TokenUsage {
  input: number;
  output: number;
  imageInput?: number;
  imageOutput?: number;
}

export interface UserTurn {
  id: string;
  role: "user";
  at: string;
  text: string;
  /** Session-relative paths of the images attached to this message. */
  images: string[];
  options: TurnOptions;
}

export interface AssistantTurn {
  id: string;
  role: "assistant";
  at: string;
  text: string;
  /** Session-relative paths of the images the turn produced. */
  images: string[];
  responseId: string;
  resumed: "chain" | "resent" | null;
  incomplete: string | null;
  usage: TokenUsage | null;
  /** How many images the provider produced that could not be saved. */
  failedImages: number;
}

export type Turn = UserTurn | AssistantTurn;

export interface SessionDoc {
  format: typeof SESSION_FORMAT;
  /** The chat's lasting id: its records carry it, since the folder's name changes with the title. Absent in chats saved before ids existed, until their next write. */
  id?: string;
  title: string;
  createdAt: string;
  turns: Turn[];
}

/** The id a chat's records carry: its own, or for a chat saved before ids existed, its folder's name. */
export function chatIdOf(folder: string, doc: SessionDoc): string {
  return doc.id ?? folder;
}

/** What the rail shows for one session. */
export interface SessionSummary {
  /** The folder's name inside the sessions folder: the session's identity. */
  id: string;
  title: string;
  createdAt: string;
  /** The last turn's time, else the creation time. */
  updatedAt: string;
  /** Session-relative path of the latest image, if any. */
  cover: string | null;
  imageCount: number;
}

/** `yyyymmdd-hhmmss-utc` for a file or folder name (timestamp-conventions). */
export function fileStamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-utc`;
}

const TITLE_WORDS = 8;
const TITLE_CHARS = 60;

/** A new session's title: the first message's opening words. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  const words = line.split(" ").slice(0, TITLE_WORDS).join(" ");
  if (words.length <= TITLE_CHARS) return words;
  return `${[...words].slice(0, TITLE_CHARS).join("").trimEnd()}…`;
}

const FOLDER_TITLE_CHARS = 40;

/** A title as a folder-name part: safe on macOS and Windows, never empty. */
export function folderPart(title: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*…]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const short = [...cleaned].slice(0, FOLDER_TITLE_CHARS).join("").trim().replace(/[. ]+$/g, "");
  return short || "session";
}

export function sessionFolderName(createdAt: Date, title: string): string {
  return `${fileStamp(createdAt)}-${folderPart(title)}`;
}

/** The stamp a session folder name starts with, kept across renames. */
export function folderStamp(id: string): string | null {
  return /^\d{8}-\d{6}-utc/.exec(id)?.[0] ?? null;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
  images: string[];
}

/**
 * The earlier turns a new message carries, oldest first, with images made
 * absolute. A user turn left unanswered (its call failed) is not history:
 * the conversation OpenAI saw never contained it.
 */
export function historyBefore(turns: readonly Turn[], index: number, absolute: (relative: string) => string): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (let i = 0; i < index; i++) {
    const turn = turns[i]!;
    if (turn.role === "user" && turns[i + 1]?.role !== "assistant") continue;
    out.push({ role: turn.role, text: turn.text, images: turn.images.map(absolute) });
  }
  return out;
}

/** The response a new turn chains from: the last assistant turn before `index`. */
export function previousResponseBefore(turns: readonly Turn[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.role === "assistant") return turn.responseId;
  }
  return undefined;
}

export function sessionTotals(turns: readonly Turn[]): { images: number; tokens: number } {
  let images = 0;
  let tokens = 0;
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    images += turn.images.length;
    const usage = turn.usage;
    if (usage) tokens += usage.input + usage.output + (usage.imageInput ?? 0) + (usage.imageOutput ?? 0);
  }
  return { images, tokens };
}

export function summarize(id: string, doc: SessionDoc): SessionSummary {
  let cover: string | null = null;
  let imageCount = 0;
  for (const turn of doc.turns) {
    if (turn.role === "assistant" && turn.images.length > 0) {
      imageCount += turn.images.length;
      cover = turn.images[turn.images.length - 1]!;
    }
  }
  const last = doc.turns[doc.turns.length - 1];
  return { id, title: doc.title, createdAt: doc.createdAt, updatedAt: last?.at ?? doc.createdAt, cover, imageCount };
}

function tokens(record: unknown, field: string): number | undefined {
  const value = record && typeof record === "object" ? (record as Record<string, unknown>)[field] : undefined;
  return typeof value === "number" ? value : undefined;
}

/** Reads a Responses API answer's tokens: `usage` for the assistant, `tool_usage.image_gen` for the image tool. */
export function usageOf(response: Record<string, unknown>): TokenUsage | null {
  const usage = response.usage;
  if (!usage || typeof usage !== "object") return null;
  const image = (response.tool_usage as Record<string, unknown> | undefined)?.image_gen;
  const imageInput = tokens(image, "input_tokens");
  const imageOutput = tokens(image, "output_tokens");
  return {
    input: tokens(usage, "input_tokens") ?? 0,
    output: tokens(usage, "output_tokens") ?? 0,
    ...(imageInput !== undefined && { imageInput }),
    ...(imageOutput !== undefined && { imageOutput }),
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRelative(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) && !path.split(/[\\/]/).includes("..");
}

/** Validates a parsed session.json; null when it is not a session this version can read. */
export function parseSession(value: unknown): SessionDoc | null {
  if (!value || typeof value !== "object") return null;
  const doc = value as Record<string, unknown>;
  if (doc.format !== SESSION_FORMAT || !isString(doc.title) || !isString(doc.createdAt) || !Array.isArray(doc.turns)) return null;
  if (doc.id !== undefined && !isString(doc.id)) return null;
  for (const raw of doc.turns) {
    if (!raw || typeof raw !== "object") return null;
    const turn = raw as Record<string, unknown>;
    if (!isString(turn.id) || !isString(turn.at) || !isString(turn.text) || !isStringArray(turn.images)) return null;
    if (!turn.images.every(isRelative)) return null;
    if (turn.role === "user") {
      const options = turn.options as Record<string, unknown> | undefined;
      if (!options || !isString(options.size) || !isString(options.quality)) return null;
      if (options.transparent !== undefined && typeof options.transparent !== "boolean") return null;
    } else if (turn.role === "assistant") {
      if (!isString(turn.responseId)) return null;
    } else {
      return null;
    }
  }
  return value as SessionDoc;
}
