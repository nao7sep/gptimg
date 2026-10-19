// backups.sqlite3 (data-backup-conventions): the bytes of each settings or
// session file the app writes, one row per path per launch, newest kept.
// Best effort: a backup that fails never stops the write it protects.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface Backups {
  keep(path: string, content: string): void;
  close(): void;
}

export function openBackups(file: string, sessionId: string, onError: (error: unknown) => void): Backups {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS backups (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content BLOB NOT NULL,
      sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      written_at_utc TEXT NOT NULL,
      PRIMARY KEY (path, session_id)
    )`);
  } catch (error) {
    onError(error);
    db = null;
  }
  const upsert = db?.prepare(`INSERT INTO backups (session_id, path, content, sha256, byte_size, written_at_utc)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (path, session_id) DO UPDATE SET content = excluded.content, sha256 = excluded.sha256,
      byte_size = excluded.byte_size, written_at_utc = excluded.written_at_utc`);
  return {
    keep(path, content) {
      if (!upsert) return;
      try {
        const bytes = Buffer.from(content, "utf8");
        const sha = createHash("sha256").update(bytes).digest("hex");
        upsert.run(sessionId, path, bytes, sha, bytes.byteLength, new Date().toISOString());
      } catch (error) {
        onError(error);
      }
    },
    close() {
      db?.close();
    },
  };
}
