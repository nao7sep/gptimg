// Chat folders: each a self-contained folder in the chats folder holding
// chat.json, the turn images with their sidecars, and inputs/ with a copy
// of every attached reference. Paths inside a chat are relative, so the
// folder can be moved or renamed whole.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import {
  INPUTS_DIR,
  CHAT_FILE,
  bySent,
  fileStamp,
  folderPart,
  folderStamp,
  parseChat,
  chatFolderName,
  summarize,
  type ChatDoc,
  type ChatSummary,
} from "../shared/chat.ts";
import type { ChatsListing, RefusedChat } from "../shared/api.ts";
import { readHeader, withHeader } from "./file-header.ts";
import { copyFileAtomic, json, readText, writeTextAtomic } from "./files.ts";

export class ChatError extends Error {
  readonly code: "notFound" | "unreadable" | "malformed" | "newer" | "badId" | "exists";
  readonly path: string;

  constructor(code: ChatError["code"], path: string) {
    super(`${code}: ${path}`);
    this.code = code;
    this.path = path;
  }
}

/** A chat id is one folder name: never a path, never a parent reference. */
export function isChatFolder(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !/[\\/\u0000]/.test(id) && basename(id) === id;
}

export function chatDir(root: string, id: string): string {
  if (!isChatFolder(id)) throw new ChatError("badId", id);
  return join(root, id);
}

/** True when `path` is inside `dir` (after resolving), so a relative path cannot climb out of its chat. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
}

export async function listChats(root: string): Promise<ChatsListing> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { chats: [], refused: [] };
    throw error;
  }
  const chats: ChatSummary[] = [];
  const refused: RefusedChat[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      chats.push(summarize(entry.name, await readChat(root, entry.name)));
    } catch (error) {
      if (error instanceof ChatError && error.code === "notFound") continue;
      refused.push({ folder: entry.name, reason: error instanceof ChatError && error.code === "newer" ? "newer" : "unreadable" });
    }
  }
  chats.sort(bySent);
  refused.sort((a, b) => (a.folder < b.folder ? -1 : 1));
  return { chats, refused };
}

/** The chat in `text`, or why it is refused; a refused chat is never written over. */
function parseJson(text: string): ChatDoc | "newer" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const header = readHeader(parsed, "chat");
  if (header.kind === "newer") return "newer";
  return header.kind === "ok" ? parseChat(header.body) : null;
}

export async function readChat(root: string, id: string): Promise<ChatDoc> {
  const path = join(chatDir(root, id), CHAT_FILE);
  const read = await readText(path);
  if (read.kind === "absent") throw new ChatError("notFound", path);
  if (read.kind === "failed") throw new ChatError("unreadable", path);
  const doc = parseJson(read.text);
  if (doc === "newer") throw new ChatError("newer", path);
  if (!doc) throw new ChatError("malformed", path);
  return doc;
}

/** Writes chat.json; returns the bytes written, or null when nothing changed. */
export async function writeChat(root: string, id: string, doc: ChatDoc): Promise<string | null> {
  const text = json(withHeader("chat", { ...doc }));
  return (await writeTextAtomic(join(chatDir(root, id), CHAT_FILE), text)) ? text : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A free name in `dir`: `name`, else `name-2`, `name-3`, … */
async function freeName(dir: string, name: string, ext = ""): Promise<string> {
  let candidate = `${name}${ext}`;
  for (let n = 2; await exists(join(dir, candidate)); n++) candidate = `${name}-${n}${ext}`;
  return candidate;
}

export async function createChat(root: string, now: Date, title: string): Promise<{ id: string; doc: ChatDoc }> {
  await mkdir(root, { recursive: true });
  const id = await freeName(root, chatFolderName(now, title));
  await mkdir(join(root, id));
  return { id, doc: { id: randomUUID(), title, createdAt: now.toISOString(), turns: [] } };
}

/** Renames a chat: its title, and its folder to match, keeping the folder's creation stamp. */
export async function renameChat(root: string, id: string, title: string): Promise<{ id: string; doc: ChatDoc }> {
  const doc = await readChat(root, id);
  const next = { ...doc, title };
  const stamp = folderStamp(id) ?? fileStamp(new Date(doc.createdAt));
  const wanted = `${stamp}-${folderPart(title)}`;
  await writeChat(root, id, next);
  let newId = id;
  if (wanted !== id) {
    newId = await freeName(root, wanted);
    await rename(chatDir(root, id), chatDir(root, newId));
  }
  return { id: newId, doc: next };
}

/**
 * Copies an attached image into the chat's inputs/, keeping its content and
 * modified time, and returns its chat-relative path. A path already inside
 * the chat is returned as it is.
 */
export async function importReference(dir: string, source: string, now: Date): Promise<string> {
  if (isInside(dir, source)) return relative(dir, source).split(sep).join("/");
  const inputs = join(dir, INPUTS_DIR);
  await mkdir(inputs, { recursive: true });
  const ext = extname(source).toLowerCase();
  const stem = basename(source, extname(source)).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 40) || "image";
  const name = await freeName(inputs, `${fileStamp(now)}-${stem}`, ext);
  const target = join(inputs, name);
  await copyFileAtomic(source, target);
  return `${INPUTS_DIR}/${name}`;
}
