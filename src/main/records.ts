// records.sqlite3 (data-lifecycle-conventions): one row per launch, the app's
// own log lines, every SDK event as the complete record it already is, and
// every turn's provider response whole with its token usage. Credentials are
// masked by the SDK before an event or response leaves it; the app's own
// lines never carry one.
import { DatabaseSync } from "node:sqlite";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface TurnRecord {
  sessionFolder: string;
  turnId: string;
  model: string;
  status: "completed" | "refused" | "failed" | "cancelled";
  responseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The provider's response, or the error's data, whole. */
  body: unknown;
}

export interface Records {
  readonly sessionId: string;
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  sdkEvent(sessionFolder: string | null, event: Record<string, unknown>): void;
  turn(record: TurnRecord): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS launches (
  session_id TEXT PRIMARY KEY,
  started_at_utc TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  at_utc TEXT NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  fields TEXT
);
CREATE TABLE IF NOT EXISTS sdk_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  at_utc TEXT NOT NULL,
  session_folder TEXT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  at_utc TEXT NOT NULL,
  session_folder TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  response_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  body TEXT NOT NULL
);
`;

function text(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Opens the records; when the database cannot be opened, records go to stderr instead and the app runs on. */
export function openRecords(file: string, sessionId: string, version: string): Records {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO launches (session_id, started_at_utc, app_version, platform) VALUES (?, ?, ?, ?)").run(
      sessionId,
      new Date().toISOString(),
      version,
      process.platform,
    );
  } catch (error) {
    console.error("[gptimg] records unavailable", error);
    db = null;
  }
  const logStmt = db?.prepare("INSERT INTO log (session_id, at_utc, level, event, fields) VALUES (?, ?, ?, ?, ?)");
  const eventStmt = db?.prepare(
    "INSERT INTO sdk_events (session_id, at_utc, session_folder, level, event, body) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const turnStmt = db?.prepare(`INSERT INTO turns (session_id, at_utc, session_folder, turn_id, model, status,
    response_id, input_tokens, output_tokens, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const guard = (write: () => void, fallback: () => string) => {
    try {
      if (!db) throw new Error("records unavailable");
      write();
    } catch {
      console.error(`[gptimg] ${fallback()}`);
    }
  };

  return {
    sessionId,
    log(level, event, fields) {
      guard(
        () => logStmt!.run(sessionId, new Date().toISOString(), level, event, fields ? text(fields) : null),
        () => `${level} ${event} ${fields ? text(fields) : ""}`,
      );
    },
    sdkEvent(sessionFolder, event) {
      const time = typeof event.time === "string" ? event.time : new Date().toISOString();
      guard(
        () => eventStmt!.run(sessionId, time, sessionFolder, String(event.level ?? "info"), String(event.event ?? ""), text(event)),
        () => `sdk ${String(event.event)}`,
      );
    },
    turn(record) {
      guard(
        () =>
          turnStmt!.run(
            sessionId,
            new Date().toISOString(),
            record.sessionFolder,
            record.turnId,
            record.model,
            record.status,
            record.responseId,
            record.inputTokens,
            record.outputTokens,
            text(record.body),
          ),
        () => `turn ${record.status} ${record.turnId}`,
      );
    },
    close() {
      db?.close();
    },
  };
}
