// Reading records.sqlite3 for the Records window: the app's log lines and the
// SDK's events side by side as log lines, and each request attempt the SDK
// reports as a provider call, newest first, a page at a time.
import type { DatabaseSync } from "node:sqlite";
import {
  RECORDS_PAGE,
  type RecordBlock,
  type RecordDetail,
  type RecordLevel,
  type RecordQuery,
  type RecordRef,
  type RecordRow,
  type RecordsPage,
} from "../shared/records.ts";

const ATTEMPTS = ["attempt.succeeded", "attempt.failed", "attempt.cancelled"];
const IN_ATTEMPTS = `(${ATTEMPTS.map((e) => `'${e}'`).join(", ")})`;

// Every record as one shape: the app's lines, and the SDK's events split into log lines and calls.
const RECORDS = `
  SELECT 'app' AS source, id, at_utc, level, event, COALESCE(message, '') AS message, chat_id, session_id, 'log' AS kind,
         COALESCE(fields, '') AS haystack
    FROM log
  UNION ALL
  SELECT 'sdk' AS source, id, at_utc, level, event, COALESCE(json_extract(body, '$.message'), '') AS message, chat_id, session_id,
         CASE WHEN event IN ${IN_ATTEMPTS} THEN 'call' ELSE 'log' END AS kind, body AS haystack
    FROM sdk_events`;

function like(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function parse(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { value };
  }
}

function asLevel(value: unknown): RecordLevel {
  return value === "error" || value === "warn" || value === "debug" ? value : "info";
}

function callModel(body: Record<string, unknown>): string {
  const request = body.request as Record<string, unknown> | undefined;
  const sent = (request?.body ?? request) as Record<string, unknown> | undefined;
  return typeof sent?.model === "string" ? sent.model : "";
}

function callTitle(event: string, body: Record<string, unknown>): string {
  const verb = typeof body.verb === "string" ? body.verb : "";
  const outcome = event.replace("attempt.", "");
  return verb ? `${verb} ${outcome}` : outcome;
}

function rowOf(r: Record<string, unknown>): RecordRow {
  const kind = r.kind === "call" ? "call" : "log";
  const event = String(r.event);
  if (kind === "call") {
    const body = parse(r.haystack);
    const duration = typeof body.durationMs === "number" ? `${body.durationMs} ms` : "";
    return {
      source: "sdk",
      id: Number(r.id),
      at: String(r.at_utc),
      level: asLevel(r.level),
      kind,
      title: callTitle(event, body),
      text: [callModel(body), duration].filter(Boolean).join(" · "),
      chatId: r.chat_id == null ? null : String(r.chat_id),
    };
  }
  return {
    source: r.source === "app" ? "app" : "sdk",
    id: Number(r.id),
    at: String(r.at_utc),
    level: asLevel(r.level),
    kind,
    title: event,
    text: String(r.message ?? ""),
    chatId: r.chat_id == null ? null : String(r.chat_id),
  };
}

export function queryRecords(db: DatabaseSync, query: RecordQuery): RecordsPage {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.launch) {
    where.push("session_id = ?");
    params.push(query.launch);
  }
  if (query.kind) {
    where.push("kind = ?");
    params.push(query.kind);
  }
  if (query.level === "attention") where.push("level IN ('warn', 'error')");
  else if (query.level) {
    where.push("level = ?");
    params.push(query.level);
  }
  if (query.chatId) {
    where.push("chat_id = ?");
    params.push(query.chatId);
  }
  const search = query.search?.trim();
  if (search) {
    where.push("(event LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\' OR haystack LIKE ? ESCAPE '\\')");
    params.push(like(search), like(search), like(search));
  }
  if (query.cursor) {
    where.push("(at_utc, source, id) < (?, ?, ?)");
    params.push(query.cursor.at, query.cursor.source, query.cursor.id);
  }
  const sql = `SELECT * FROM (${RECORDS}) ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at_utc DESC, source DESC, id DESC LIMIT ${RECORDS_PAGE + 1}`;
  const found = db.prepare(sql).all(...params) as Record<string, unknown>[];
  const rows = found.slice(0, RECORDS_PAGE).map(rowOf);
  const last = rows[rows.length - 1];
  return { rows, next: found.length > RECORDS_PAGE && last ? { at: last.at, source: last.source, id: last.id } : null, failed: false };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function detailOf(db: DatabaseSync, ref: RecordRef): RecordDetail | null {
  if (ref.source === "app") {
    const r = db.prepare("SELECT * FROM log WHERE id = ?").get(ref.id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const fields = parse(r.fields);
    return {
      ...ref,
      kind: "log",
      level: asLevel(r.level),
      title: String(r.event),
      text: String(r.message ?? ""),
      at: String(r.at_utc),
      chatId: r.chat_id == null ? null : String(r.chat_id),
      launchId: String(r.session_id),
      fields: [
        { label: "event", value: String(r.event) },
        { label: "message", value: String(r.message ?? "") },
      ],
      blocks: Object.keys(fields).length ? [{ label: "details", text: json(fields) }] : [],
    };
  }
  const r = db.prepare("SELECT * FROM sdk_events WHERE id = ?").get(ref.id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const body = parse(r.body);
  const event = String(r.event);
  const base = {
    ...ref,
    level: asLevel(r.level),
    at: String(r.at_utc),
    chatId: r.chat_id == null ? null : String(r.chat_id),
    launchId: String(r.session_id),
  };
  if (ATTEMPTS.includes(event)) {
    const blocks: RecordBlock[] = [];
    if (body.request !== undefined) blocks.push({ label: "request", text: json(body.request) });
    if (body.response !== undefined) blocks.push({ label: "response", text: json(body.response) });
    if (body.error !== undefined) blocks.push({ label: "error", text: json(body.error) });
    const fields: RecordDetail["fields"] = [{ label: "operation", value: callTitle(event, body) }];
    const model = callModel(body);
    if (model) fields.push({ label: "model", value: model });
    if (typeof body.attempt === "number") fields.push({ label: "attempt", value: `${body.attempt} / ${Number(body.maxRetries ?? 0) + 1}` });
    if (typeof body.durationMs === "number") fields.push({ label: "duration", value: `${body.durationMs} ms` });
    if (typeof body.status === "number") fields.push({ label: "status", value: body.status });
    return { ...base, kind: "call", title: callTitle(event, body), text: String(body.message ?? ""), fields, blocks };
  }
  return {
    ...base,
    kind: "log",
    title: event,
    text: String(body.message ?? ""),
    fields: [
      { label: "event", value: event },
      { label: "message", value: String(body.message ?? "") },
    ],
    blocks: [{ label: "details", text: json(body) }],
  };
}
