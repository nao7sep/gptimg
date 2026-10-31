// backups.sqlite3 (data-backup-conventions): the bytes of each settings or
// chat file the app writes, one row per path per launch, newest kept.
// Best effort: a backup that fails never stops the write it protects.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { claimDatabase } from "./file-header.ts";

export interface Backups {
  keep(path: string, content: string): void;
  close(): void;
}

export function openBackups(file: string, sessionId: string, onError: (error: unknown) => void): Backups {
  const report = (error: unknown): void => {
    try { onError(error); } catch (reportError) { console.error("[gptimg] backup diagnostic failed", error, reportError); }
  };
  let db: DatabaseSync | null = null;
  let upsert: ReturnType<DatabaseSync["prepare"]> | undefined;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN");
    claimDatabase(db, "backups");
    db.exec(`CREATE TABLE IF NOT EXISTS backups (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content BLOB NOT NULL,
      sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      written_at_utc TEXT NOT NULL,
      PRIMARY KEY (path, session_id)
    )`);
    upsert = db.prepare(`INSERT INTO backups (session_id, path, content, sha256, byte_size, written_at_utc)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (path, session_id) DO UPDATE SET content = excluded.content, sha256 = excluded.sha256,
        byte_size = excluded.byte_size, written_at_utc = excluded.written_at_utc`);
    db.exec("COMMIT");
  } catch (error) {
    try { db?.close(); } catch (closeError) { report(closeError); }
    report(error);
    db = null;
    upsert = undefined;
  }
  return {
    keep(path, content) {
      if (!upsert) return;
      try {
        const bytes = Buffer.from(content, "utf8");
        const sha = createHash("sha256").update(bytes).digest("hex");
        upsert.run(sessionId, path, bytes, sha, bytes.byteLength, new Date().toISOString());
      } catch (error) {
        report(error);
      }
    },
    close() {
      try { db?.close(); } catch (error) { report(error); }
    },
  };
}
