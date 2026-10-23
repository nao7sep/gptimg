// records.sqlite3 (data-lifecycle-conventions, logging-conventions): one row
// per launch; the app's own log lines, each a complete record (time, level,
// a stable event name, its fixed message, fields); every SDK event as the
// complete record it already is; and every turn's provider response whole
// with its token usage. Each row carries its launch and, where it has one,
// the chat it belongs to. Credentials are masked by the SDK before an event
// or response leaves it; the app's own lines never carry one. A write that
// fails falls back to a JSON line under logs/, then to the console.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileStamp } from "../shared/session.ts";
import { queryRecords, detailOf } from "./records-query.ts";
import type { LaunchEntry, RecordDetail, RecordQuery, RecordRef, RecordsPage } from "../shared/records.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Every event the app logs, with its fixed message: the event names what happened, the fields say the rest. */
export const APP_EVENTS = {
  "app.start": "GptImg started",
  "app.quit": "GptImg quit",
  "settings.loadProblem": "settings could not all be read",
  "settings.saved": "settings saved",
  "settings.saveFailed": "settings could not be saved",
  "state.saveFailed": "window state could not be saved",
  "language.appleLanguagesFailed": "macOS language preference could not be written",
  "apiKeys.saved": "API key saved",
  "apiKeys.cleared": "API key cleared",
  "apiKeys.writeFailed": "API key could not be saved",
  "apiKeys.modeTightened": "API key file permissions tightened to owner-only",
  "backups.failed": "a backup could not be written",
  "sessions.created": "chat created",
  "sessions.renamed": "chat renamed",
  "sessions.renameFailed": "chat could not be renamed",
  "sessions.trashed": "chat moved to the trash",
  "sessions.trashFailed": "chat could not be moved to the trash",
  "sessions.listFailed": "chats folder could not be read",
  "turn.sent": "message sent",
  "turn.replied": "reply received",
  "turn.failed": "reply did not arrive",
  "turn.cancelled": "reply stopped",
  "turn.saveFailed": "message could not be saved",
  "turn.replySaveFailed": "reply could not be saved",
  "export.done": "image exported",
  "export.failed": "image could not be exported",
  "export.writeFailed": "exported image could not be written",
  "mask.saveFailed": "painted mask could not be saved",
  "model.installed": "upscaling model downloaded",
  "model.installFailed": "upscaling model could not be downloaded",
  "model.released": "upscaling model unloaded",
  "model.releaseFailed": "upscaling model could not be unloaded",
  "sdk.workerExit": "image engine process exited",
  "window.closeFailed": "close confirmation could not be shown",
  "window.loadFailed": "window could not load",
  "window.rendererGone": "window renderer stopped",
  "window.console": "window reported a problem",
  "window.preloadFailed": "window bridge could not load",
} as const;

export type AppEvent = keyof typeof APP_EVENTS;

export interface TurnRecord {
  chatId: string;
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
  log(level: LogLevel, event: AppEvent, fields?: Record<string, unknown>): void;
  sdkEvent(chat: { id: string; folder: string } | null, event: Record<string, unknown>): void;
  turn(record: TurnRecord): void;
  launches(): LaunchEntry[];
  query(query: RecordQuery): RecordsPage;
  detail(ref: RecordRef): RecordDetail | null;
  /** Called after each record write settles, including failure, so Records can refresh. */
  onChange(listener: () => void): void;
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
  message TEXT,
  chat_id TEXT,
  fields TEXT
);
CREATE TABLE IF NOT EXISTS sdk_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  at_utc TEXT NOT NULL,
  session_folder TEXT,
  chat_id TEXT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  at_utc TEXT NOT NULL,
  session_folder TEXT NOT NULL,
  chat_id TEXT,
  turn_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  response_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  body TEXT NOT NULL
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS log_launch ON log (session_id, id);
CREATE INDEX IF NOT EXISTS sdk_events_launch ON sdk_events (session_id, id);
CREATE INDEX IF NOT EXISTS sdk_events_chat ON sdk_events (chat_id, id);
CREATE INDEX IF NOT EXISTS turns_chat ON turns (chat_id, id);
CREATE INDEX IF NOT EXISTS log_time ON log (at_utc);
CREATE INDEX IF NOT EXISTS sdk_events_time ON sdk_events (at_utc);
`;

function text(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function diagnostic(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: error };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...("code" in error && { code: error.code }),
    ...(error.cause !== undefined && { cause: diagnostic(error.cause) }),
  };
}

/** Opens the records; when the database cannot be opened, every record takes the fallback and the app runs on. */
export function openRecords(file: string, logsDir: string, sessionId: string, version: string): Records {
  const startedAt = new Date();
  let db: DatabaseSync | null = null;
  let degraded: unknown;
  let logStmt: ReturnType<DatabaseSync["prepare"]> | undefined;
  let eventStmt: ReturnType<DatabaseSync["prepare"]> | undefined;
  let turnStmt: ReturnType<DatabaseSync["prepare"]> | undefined;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    // Unsupported schemas are not migrated. Roll back initialization if any
    // required statement cannot be prepared, preserving their schema and rows.
    db.exec("BEGIN");
    db.exec(SCHEMA);
    logStmt = db.prepare("INSERT INTO log (session_id, at_utc, level, event, message, chat_id, fields) VALUES (?, ?, ?, ?, ?, ?, ?)");
    eventStmt = db.prepare(
      "INSERT INTO sdk_events (session_id, at_utc, session_folder, chat_id, level, event, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    turnStmt = db.prepare(`INSERT INTO turns (session_id, at_utc, session_folder, chat_id, turn_id, model, status,
      response_id, input_tokens, output_tokens, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec(INDEXES);
    db.prepare("INSERT INTO launches (session_id, started_at_utc, app_version, platform) VALUES (?, ?, ?, ?)").run(
      sessionId,
      startedAt.toISOString(),
      version,
      process.platform,
    );
    db.exec("COMMIT");
  } catch (error) {
    degraded = error;
    // Closing rolls back an open initialization transaction. A close failure
    // must not replace the setup failure that explains the fallback.
    try { db?.close(); } catch (closeError) { console.error("[gptimg] records close failed", closeError); }
    console.error("[gptimg] records unavailable", error);
    db = null;
  }

  // The launch's fallback log, named by its start, created only when a write first fails.
  const fallbackFile = join(logsDir, `${fileStamp(startedAt)}.log`);
  const fallback = (line: Record<string, unknown>) => {
    const json = JSON.stringify({ time: new Date().toISOString(), session: sessionId, ...line });
    try {
      mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      appendFileSync(fallbackFile, `${json}\n`, { mode: 0o600 });
    } catch {
      console.error(`[gptimg] ${json}`);
    }
  };

  const listeners: (() => void)[] = [];
  const guard = (write: () => void, line: () => Record<string, unknown>) => {
    try {
      if (!db) throw degraded;
      write();
    } catch (error) {
      degraded ??= error;
      fallback({ ...line(), storageError: diagnostic(error) });
    }
    for (const listener of listeners) {
      try { listener(); } catch (error) { console.error("[gptimg] records listener failed", error); }
    }
  };

  return {
    sessionId,
    log(level, event, fields) {
      const message = APP_EVENTS[event];
      const chatId = typeof fields?.chatId === "string" ? fields.chatId : null;
      guard(
        () => logStmt!.run(sessionId, new Date().toISOString(), level, event, message, chatId, fields ? text(fields) : null),
        () => ({ level, event, message, ...(fields && { fields }) }),
      );
    },
    sdkEvent(chat, event) {
      const time = typeof event.time === "string" ? event.time : new Date().toISOString();
      guard(
        () => eventStmt!.run(sessionId, time, chat?.folder ?? null, chat?.id ?? null, String(event.level ?? "info"), String(event.event ?? ""), text(event)),
        () => ({ level: String(event.level ?? "info"), event: `sdk.${String(event.event ?? "")}`, message: String(event.message ?? ""), chat, body: event }),
      );
    },
    turn(record) {
      guard(
        () =>
          turnStmt!.run(
            sessionId,
            new Date().toISOString(),
            record.sessionFolder,
            record.chatId,
            record.turnId,
            record.model,
            record.status,
            record.responseId,
            record.inputTokens,
            record.outputTokens,
            text(record.body),
          ),
        () => ({ level: record.status === "completed" ? "info" : "warn", event: "turn.record", message: `turn ${record.status}`, record }),
      );
    },
    launches() {
      if (!db) return [];
      return (db.prepare("SELECT session_id, started_at_utc, app_version FROM launches ORDER BY started_at_utc DESC").all() as Record<string, unknown>[]).map(
        (r) => ({ id: String(r.session_id), startedAt: String(r.started_at_utc), version: String(r.app_version), current: r.session_id === sessionId }),
      );
    },
    query(query) {
      if (!db) return { rows: [], next: null, failed: true };
      try {
        const page = queryRecords(db, query);
        return { ...page, failed: degraded !== undefined || page.failed };
      } catch {
        return { rows: [], next: null, failed: true };
      }
    },
    detail(ref) {
      if (!db) return null;
      try {
        return detailOf(db, ref);
      } catch {
        return null;
      }
    },
    onChange(listener) {
      listeners.push(listener);
    },
    close() {
      db?.close();
    },
  };
}
