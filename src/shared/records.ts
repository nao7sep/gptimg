// What the Records window asks of records.sqlite3, and what comes back.

/** The three kinds of record: the app's own activity, each OpenAI call's outcome, and the SDK's events. */
export const RECORD_KINDS = ["log", "calls", "events"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface RecordQuery {
  kind: RecordKind;
  /** This launch only, or every launch. */
  scope: "launch" | "all";
  /** Only the records of one chat. */
  chatId?: string;
  /** For the next page: the smallest id already shown. */
  beforeId?: number;
}

export interface RecordRow {
  id: number;
  at: string;
  level: "debug" | "info" | "warn" | "error";
  /** The event name, or for a call its status. */
  event: string;
  /** The event's message, or for a call its model. */
  summary: string;
  chatId: string | null;
  tokens?: { input: number | null; output: number | null };
}

export interface RecordsPage {
  rows: RecordRow[];
  /** More rows are older than the last one. */
  more: boolean;
  /** The database could not be opened this launch. */
  unavailable: boolean;
}

export interface RecordDetail {
  kind: RecordKind;
  id: number;
  /** The row's own columns. */
  columns: Record<string, unknown>;
  /** The record whole: the log line's fields, the SDK event, or the provider's response. */
  body: unknown;
}
