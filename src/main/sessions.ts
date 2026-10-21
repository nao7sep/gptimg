// Session folders: each a self-contained folder in the sessions folder holding
// session.json, the turn images with their sidecars, and inputs/ with a copy
// of every attached reference. Paths inside a session are relative, so the
// folder can be moved or renamed whole.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, stat, utimes } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import {
  INPUTS_DIR,
  SESSION_FILE,
  SESSION_FORMAT,
  fileStamp,
  folderPart,
  folderStamp,
  parseSession,
  sessionFolderName,
  summarize,
  type SessionDoc,
  type SessionSummary,
} from "../shared/session.ts";
import { json, readText, writeTextAtomic } from "./files.ts";

export class SessionError extends Error {
  readonly code: "notFound" | "unreadable" | "malformed" | "badId" | "exists";
  readonly path: string;

  constructor(code: SessionError["code"], path: string) {
    super(`${code}: ${path}`);
    this.code = code;
    this.path = path;
  }
}

/** A session id is one folder name: never a path, never a parent reference. */
export function isSessionId(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !/[\\/]/.test(id) && basename(id) === id;
}

export function sessionDir(root: string, id: string): string {
  if (!isSessionId(id)) throw new SessionError("badId", id);
  return join(root, id);
}

/** True when `path` is inside `dir` (after resolving), so a relative path cannot climb out of its session. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
}

export async function listSessions(root: string): Promise<{ sessions: SessionSummary[]; unreadable: number }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], unreadable: 0 };
    throw error;
  }
  const sessions: SessionSummary[] = [];
  let unreadable = 0;
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const read = await readText(join(root, entry.name, SESSION_FILE));
        if (read.kind === "absent") return;
        const doc = read.kind === "ok" ? parseJson(read.text) : null;
        if (!doc) {
          unreadable++;
          return;
        }
        sessions.push(summarize(entry.name, doc));
      }),
  );
  sessions.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : a.id < b.id ? 1 : -1));
  return { sessions, unreadable };
}

function parseJson(text: string): SessionDoc | null {
  try {
    return parseSession(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function readSession(root: string, id: string): Promise<SessionDoc> {
  const path = join(sessionDir(root, id), SESSION_FILE);
  const read = await readText(path);
  if (read.kind === "absent") throw new SessionError("notFound", path);
  if (read.kind === "failed") throw new SessionError("unreadable", path);
  const doc = parseJson(read.text);
  if (!doc) throw new SessionError("malformed", path);
  return doc;
}

/** A chat saved before ids existed gains its lasting id with its next real write; launch and reading write nothing. */
export function withId(doc: SessionDoc): SessionDoc {
  return doc.id ? doc : { format: doc.format, id: randomUUID(), title: doc.title, createdAt: doc.createdAt, turns: doc.turns };
}

/** Writes session.json; returns the bytes written, or null when nothing changed. */
export async function writeSession(root: string, id: string, doc: SessionDoc): Promise<string | null> {
  const text = json(doc);
  return (await writeTextAtomic(join(sessionDir(root, id), SESSION_FILE), text)) ? text : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A free name in `dir`: `name`, else `name-2`, `name-3`, … */
async function freeName(dir: string, name: string, ext = ""): Promise<string> {
  let candidate = `${name}${ext}`;
  for (let n = 2; await exists(join(dir, candidate)); n++) candidate = `${name}-${n}${ext}`;
  return candidate;
}

export async function createSession(root: string, now: Date, title: string): Promise<{ id: string; doc: SessionDoc }> {
  await mkdir(root, { recursive: true });
  const id = await freeName(root, sessionFolderName(now, title));
  await mkdir(join(root, id));
  return { id, doc: { format: SESSION_FORMAT, id: randomUUID(), title, createdAt: now.toISOString(), turns: [] } };
}

/** Renames a session: its title, and its folder to match, keeping the folder's creation stamp. */
export async function renameSession(root: string, id: string, title: string): Promise<{ id: string; doc: SessionDoc }> {
  const doc = withId(await readSession(root, id));
  const next = { ...doc, title };
  const stamp = folderStamp(id) ?? fileStamp(new Date(doc.createdAt));
  const wanted = `${stamp}-${folderPart(title)}`;
  let newId = id;
  if (wanted !== id) {
    newId = await freeName(root, wanted);
    await rename(sessionDir(root, id), sessionDir(root, newId));
  }
  await writeSession(root, newId, next);
  return { id: newId, doc: next };
}

/**
 * Copies an attached image into the session's inputs/, keeping its content and
 * modified time, and returns its session-relative path. A path already inside
 * the session is returned as it is.
 */
export async function importReference(dir: string, source: string, now: Date): Promise<string> {
  if (isInside(dir, source)) return relative(dir, source).split(sep).join("/");
  const inputs = join(dir, INPUTS_DIR);
  await mkdir(inputs, { recursive: true });
  const ext = extname(source).toLowerCase();
  const stem = basename(source, extname(source)).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 40) || "image";
  const name = await freeName(inputs, `${fileStamp(now)}-${stem}`, ext);
  const target = join(inputs, name);
  await copyFile(source, target);
  const times = await stat(source);
  await utimes(target, times.atime, times.mtime);
  return `${INPUTS_DIR}/${name}`;
}
