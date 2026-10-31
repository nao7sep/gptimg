// A chat as it is kept in its folder's chat.json, and the pure rules
// around it: naming, titles, the history a turn sends, token totals.
import type { Usage } from "gptimgsdk/types";

export const CHAT_FILE = "chat.json";
export const INPUTS_DIR = "inputs";

export const BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
export type Background = (typeof BACKGROUNDS)[number];

/** The image choices a user turn was sent with. */
export interface TurnOptions {
  /** "auto" or "<w>x<h>". */
  size: string;
  quality: string;
  /** Ask the image model for a transparent or an opaque background; absent, the model decides. */
  background?: "transparent" | "opaque";
}

/** The background a turn asks for. */
export function backgroundOf(options: TurnOptions): Background {
  return options.background ?? "auto";
}

/** A turn's tokens: the assistant model's, and the image tool's apart, since the two are billed at different rates. */
/** A turn's tokens, as the SDK reports them on its result. */
export type TokenUsage = Usage;

export interface UserTurn {
  id: string;
  role: "user";
  at: string;
  text: string;
  /** Chat-relative paths of the images attached to this message. */
  images: string[];
  /** A painted mask (chat-relative) for the first of `images`: only its transparent area may change. */
  mask?: string;
  options: TurnOptions;
}

export interface AssistantTurn {
  id: string;
  role: "assistant";
  at: string;
  text: string;
  /** Chat-relative paths of the images the turn produced. */
  images: string[];
  responseId: string;
  resumed: "chain" | "resent" | null;
  incomplete: string | null;
  usage: TokenUsage | null;
  /** How many images arrived but could not be saved. */
  failedImages: number;
  /** How many images the provider's moderation blocked; absent when none were. */
  blockedImages?: number;
  /** How many images the image tool failed to return for another reason. */
  missingImages?: number;
}

export type Turn = UserTurn | AssistantTurn;

export interface ChatDoc {
  /** The chat's lasting id: its records carry it, since the folder's name changes with the title. */
  id: string;
  title: string;
  createdAt: string;
  turns: Turn[];
}

/** What the rail shows for one chat. */
export interface ChatSummary {
  /** The folder's name inside the chats folder: the chat's identity. */
  id: string;
  /** The lasting id used by chat records. */
  chatId: string;
  title: string;
  createdAt: string;
  /** The last turn's time, else the creation time. */
  updatedAt: string;
  /**
   * The last message the user sent, else the creation time: what the chat
   * list orders by (developer decision, as ChatGPT orders chats). Sending moves
   * a chat to the top; a reply arriving later, even while the user has since
   * sent in another chat, does not move it.
   */
  sentAt: string;
  /** Chat-relative path of the latest image, if any. */
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

/** A new chat's title: the first message's opening words. */
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
  return short || "chat";
}

export function chatFolderName(createdAt: Date, title: string): string {
  return `${fileStamp(createdAt)}-${folderPart(title)}`;
}

/** The stamp a chat folder name starts with, kept across renames. */
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

export function chatTotals(turns: readonly Turn[]): { images: number; tokens: number } {
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

export function summarize(id: string, doc: ChatDoc): ChatSummary {
  let cover: string | null = null;
  let imageCount = 0;
  for (const turn of doc.turns) {
    if (turn.role === "assistant" && turn.images.length > 0) {
      imageCount += turn.images.length;
      cover = turn.images[turn.images.length - 1]!;
    }
  }
  const last = doc.turns[doc.turns.length - 1];
  const lastSent = doc.turns.findLast((turn) => turn.role === "user");
  return { id, chatId: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: last?.at ?? doc.createdAt, sentAt: lastSent?.at ?? doc.createdAt, cover, imageCount };
}

/** The chat list's order: latest sent first, then by folder name. */
export function bySent(a: ChatSummary, b: ChatSummary): number {
  return a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : a.id < b.id ? 1 : -1;
}

/**
 * One change to the chats folder's listing. `entry`: the chat once at
 * folder `id` is now `chat` (a rename gives it a new id), or is gone when
 * `chat` is null. `folder`: the chats folder itself changed, so the
 * listing is read anew.
 */
export type ChatChange = { kind: "entry"; id: string; chat: ChatSummary | null } | { kind: "folder" };

/** A listing with one entry change applied, in list order. */
export function applyChatChange(chats: ChatSummary[], id: string, chat: ChatSummary | null): ChatSummary[] {
  const rest = chats.filter((entry) => entry.id !== id && entry.id !== chat?.id);
  return chat ? [...rest, chat].sort(bySent) : rest;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRelative(path: string): boolean {
  return path !== "" && path !== "." && !/[\\\u0000]/.test(path) && !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) && !path.split("/").includes("..");
}

function isTimestamp(value: unknown): value is string {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function isNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return isNonnegative(value) && Number.isInteger(value);
}

function isUsage(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return isNonnegative(usage.input) && isNonnegative(usage.output)
    && (usage.imageInput === undefined || isNonnegative(usage.imageInput))
    && (usage.imageOutput === undefined || isNonnegative(usage.imageOutput));
}

/** Validates chat.json's content, its header already checked; null when it is not a chat this version can read. */
export function parseChat(value: unknown): ChatDoc | null {
  if (!value || typeof value !== "object") return null;
  const doc = value as Record<string, unknown>;
  if (!isString(doc.title) || !isTimestamp(doc.createdAt) || !Array.isArray(doc.turns)) return null;
  if (!isString(doc.id)) return null;
  for (const raw of doc.turns) {
    if (!raw || typeof raw !== "object") return null;
    const turn = raw as Record<string, unknown>;
    if (!isString(turn.id) || !isTimestamp(turn.at) || !isString(turn.text) || !isStringArray(turn.images)) return null;
    if (!turn.images.every(isRelative)) return null;
    if (turn.role === "user") {
      const options = turn.options as Record<string, unknown> | undefined;
      if (!options || typeof options !== "object" || Array.isArray(options) || !isString(options.size) || !isString(options.quality)) return null;
      if (turn.mask !== undefined && (!isString(turn.mask) || !isRelative(turn.mask))) return null;
      if (options.background !== undefined && options.background !== "transparent" && options.background !== "opaque") return null;
    } else if (turn.role === "assistant") {
      if (!isString(turn.responseId)) return null;
      if (turn.resumed !== null && turn.resumed !== "chain" && turn.resumed !== "resent") return null;
      if (turn.incomplete !== null && !isString(turn.incomplete)) return null;
      if (!isUsage(turn.usage) || !isCount(turn.failedImages)) return null;
      if (turn.blockedImages !== undefined && !isCount(turn.blockedImages)) return null;
      if (turn.missingImages !== undefined && !isCount(turn.missingImages)) return null;
    } else {
      return null;
    }
  }
  return value as ChatDoc;
}
