// What the Records window asks of records.sqlite3, and what comes back.

/** A log line (the app's own lines and the SDK's events) or a provider call (one request attempt). */
export const RECORD_KINDS = ["log", "call"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_LEVELS = ["error", "warn", "info", "debug"] as const;
export type RecordLevel = (typeof RECORD_LEVELS)[number];

/** Where a row lives: the app's own log table or the SDK's events. */
export type RecordSource = "app" | "sdk";

export interface RecordRef {
  source: RecordSource;
  id: number;
}

export interface RecordQuery {
  /** Literal text to find in the record. */
  search?: string;
  /** A launch's id, or all launches. */
  launch?: string;
  kind?: RecordKind;
  /** One level, or "attention" for warnings and errors. */
  level?: RecordLevel | "attention";
  chatId?: string;
  /** Continue after the last row of the previous page. */
  cursor?: RecordCursor;
}

export interface RecordCursor {
  at: string;
  source: RecordSource;
  id: number;
}

export interface RecordRow extends RecordRef {
  at: string;
  level: RecordLevel;
  kind: RecordKind;
  /** The event name, or for a call its operation and outcome. */
  title: string;
  /** The event's message, or for a call its model and duration. */
  text: string;
  chatId: string | null;
}

export interface RecordsPage {
  rows: RecordRow[];
  /** Where the next page starts, or null at the oldest record. */
  next: RecordCursor | null;
  /** The records could not be read. */
  failed: boolean;
}

export interface LaunchEntry {
  id: string;
  startedAt: string;
  version: string;
  current: boolean;
}

export interface RecordField {
  label: "time" | "level" | "kind" | "event" | "message" | "chat" | "launch" | "operation" | "model" | "attempt" | "duration" | "status";
  value: string;
}

export interface RecordBlock {
  label: "details" | "request" | "response" | "error";
  /** Pretty-printed JSON. */
  text: string;
}

export interface RecordDetail extends RecordRef {
  kind: RecordKind;
  level: RecordLevel;
  title: string;
  text: string;
  at: string;
  chatId: string | null;
  launchId: string;
  fields: { label: RecordField["label"]; value: string | number }[];
  blocks: RecordBlock[];
}

export const RECORDS_PAGE = 100;
