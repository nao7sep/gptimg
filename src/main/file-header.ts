// The identity header every file GptImg writes in its own format carries
// (file-identity-conventions): `format` says what the file is, `writer` which
// build saved it. Readers check `format` alone and never read `writer`.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

/** Why a file was refused: a later version wrote it, or it cannot be read as this kind. */
export type Refusal = "newer" | "unreadable";

/** A refused file, named for the message that reports it. */
export interface RefusedFile {
  path: string;
  reason: Refusal;
}

/** A store refused before anything touched it. */
export class StoreRefused extends Error {
  readonly path: string;
  readonly reason: Refusal;

  constructor(path: string, reason: Refusal) {
    super(reason === "newer" ? `${path} was written by a newer version of GptImg; it was left unchanged` : `${path} is not a GptImg database this version reads; it was left unchanged`);
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Checks a SQLite store's header from a read-only connection, before anything
 * opens it for writing (no journal-mode change, schema step or writer row
 * reaches a refused file). "new" for a missing or empty file.
 */
export function probeDatabase(file: string, kind: FileKind): "new" | "ok" | Refusal {
  if (!existsSync(file)) return "new";
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n;
    if (version === 0 && tables === 0) return "new";
    if (version > FORMAT_VERSION) return "newer";
    const hasHeader = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'file_header'").get() as { n: number }).n === 1;
    if (!hasHeader) return "unreadable";
    const rows = new Map((db.prepare("SELECT key, value FROM file_header").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    return checkFormat({ owner: rows.get("format.owner"), kind: rows.get("format.kind"), version }, kind) === "ok" ? "ok" : "unreadable";
  } catch {
    return "unreadable";
  } finally {
    try { db?.close(); } catch { /* the probe's answer stands */ }
  }
}

/** Throws StoreRefused unless the store at `file` may be opened for writing; true when it is new. */
export function admitDatabase(file: string, kind: FileKind): boolean {
  const probe = probeDatabase(file, kind);
  if (probe === "newer" || probe === "unreadable") throw new StoreRefused(file, probe);
  return probe === "new";
}

/**
 * Inside the caller's open transaction on an admitted store: a new one gets
 * its version and header rows, and every open rewrites the writer rows.
 */
export function stampDatabase(db: DatabaseSync, kind: FileKind, fresh: boolean): void {
  if (fresh) {
    db.exec("CREATE TABLE IF NOT EXISTS file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(`PRAGMA user_version = ${FORMAT_VERSION}`);
  }
  const upsert = db.prepare("INSERT INTO file_header (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  if (fresh) {
    upsert.run("format.owner", OWNER);
    upsert.run("format.kind", kind);
  }
  upsert.run("writer.name", APP_WRITER.name);
  upsert.run("writer.version", APP_WRITER.version);
}
