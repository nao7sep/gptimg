// The identity header every file GptImg writes in its own format carries
// (file-identity-conventions): `format` says what the file is, `writer` which
// build saved it. Readers check `format` alone and never read `writer`.
import manifest from "../../package.json" with { type: "json" };

export const OWNER = "gptimg";
export const FORMAT_VERSION = 1;

export type FileKind = "chat" | "config" | "state" | "api-keys" | "records" | "backups";

/** This app as a writer of files, and as the caller the SDK records in its sidecars. */
export const APP_WRITER = { name: manifest.name, version: manifest.version };

/** The content with the header as its first two keys; a `format` or `writer` already in it is replaced. */
export function withHeader(kind: FileKind, content: Record<string, unknown>): Record<string, unknown> {
  const { format: _format, writer: _writer, ...rest } = content;
  return { format: { owner: OWNER, kind, version: FORMAT_VERSION }, writer: APP_WRITER, ...rest };
}

export type HeaderRead =
  | { kind: "ok"; body: Record<string, unknown> }
  /** A later format version: left untouched. */
  | { kind: "newer"; version: number }
  /** Not a JSON object, or no header of this owner and kind. */
  | { kind: "unreadable" };

/** Checks a parsed file's header against `kind`; on success, the content without the header. */
export function readHeader(parsed: unknown, kind: FileKind): HeaderRead {
  if (!isObject(parsed)) return { kind: "unreadable" };
  const { format, writer: _writer, ...body } = parsed;
  const checked = checkFormat(format, kind);
  return checked === "ok" ? { kind: "ok", body } : checked;
}

function checkFormat(format: unknown, kind: FileKind): "ok" | { kind: "newer"; version: number } | { kind: "unreadable" } {
  if (!isObject(format) || format.owner !== OWNER || format.kind !== kind) return { kind: "unreadable" };
  const version = format.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { kind: "unreadable" };
  if (version > FORMAT_VERSION) return { kind: "newer", version };
  return "ok";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface HeaderDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: string[]): unknown; all(...params: string[]): unknown[]; run(...params: string[]): unknown };
}

/**
 * Checks a SQLite store's header inside the caller's open transaction and
 * rewrites its writer rows; a new empty database gets the header. Throws for
 * a newer or unreadable store, so the caller rolls back and leaves it as it is.
 */
export function claimDatabase(db: HeaderDatabase, kind: FileKind): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n;
  if (version === 0 && tables === 0) {
    db.exec("CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(`PRAGMA user_version = ${FORMAT_VERSION}`);
    const insert = db.prepare("INSERT INTO file_header (key, value) VALUES (?, ?)");
    insert.run("format.owner", OWNER);
    insert.run("format.kind", kind);
  } else {
    if (version > FORMAT_VERSION) throw new Error(`${kind} store has format version ${version}, newer than ${FORMAT_VERSION}; it was left unchanged`);
    const hasHeader = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'file_header'").get() as { n: number }).n === 1;
    const rows = hasHeader ? new Map((db.prepare("SELECT key, value FROM file_header").all() as { key: string; value: string }[]).map((r) => [r.key, r.value])) : new Map<string, string>();
    const format = { owner: rows.get("format.owner"), kind: rows.get("format.kind"), version };
    if (checkFormat(format, kind) !== "ok") throw new Error(`${kind} store is not a GptImg ${kind} database of format ${FORMAT_VERSION}; it was left unchanged`);
  }
  const upsert = db.prepare("INSERT INTO file_header (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  upsert.run("writer.name", APP_WRITER.name);
  upsert.run("writer.version", APP_WRITER.version);
}
