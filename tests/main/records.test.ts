import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_EVENTS, openRecords } from "../../src/main/records.ts";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "gptimg-records-"));
  directories.push(dir);
  return { file: join(dir, "records.sqlite3"), logs: join(dir, "logs"), dir };
};

const attempt = (event: string, at: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  time: at,
  level: event === "attempt.failed" ? "warn" : "info",
  verb: "chat",
  event,
  message: "request attempt",
  budget: "imageGenerate",
  attempt: 1,
  maxRetries: 2,
  durationMs: 1234,
  request: { body: { model: "gpt-5.6-terra" } },
  ...extra,
});

describe("records", () => {
  it("keeps each log line with its fixed message, its launch and its chat", () => {
    const { file, logs } = fresh();
    const records = openRecords(file, logs, "launch-1", "1.0.0");
    records.log("info", "turn.sent", { chatId: "chat-a", turnId: "t1" });
    const page = records.query({});
    expect(page.rows[0]).toMatchObject({ source: "app", kind: "log", title: "turn.sent", text: APP_EVENTS["turn.sent"], chatId: "chat-a", level: "info" });
    const detail = records.detail({ source: "app", id: page.rows[0]!.id });
    expect(detail).toMatchObject({ kind: "log", launchId: "launch-1", blocks: [{ label: "details" }] });
    expect(JSON.parse(detail!.blocks[0]!.text)).toEqual({ chatId: "chat-a", turnId: "t1" });
    records.close();
  });

  it("shows the SDK's events as log lines and each request attempt as a provider call", () => {
    const { file, logs } = fresh();
    const records = openRecords(file, logs, "l", "1");
    records.sdkEvent({ id: "c", folder: "f" }, { time: "2026-10-19T00:00:01.000Z", level: "info", event: "verb.start", message: "verb started" });
    records.sdkEvent({ id: "c", folder: "f" }, attempt("attempt.succeeded", "2026-10-19T00:00:02.000Z", { response: { id: "resp_1" } }));
    records.sdkEvent({ id: "c", folder: "f" }, attempt("attempt.failed", "2026-10-19T00:00:03.000Z", { status: 429, error: { name: "RateLimitError", message: "slow down", code: null } }));
    expect(records.query({ kind: "log" }).rows.map((r) => r.title)).toEqual(["verb.start"]);
    const calls = records.query({ kind: "call" }).rows;
    expect(calls.map((r) => r.title)).toEqual(["chat failed", "chat succeeded"]);
    expect(calls[1]!.text).toBe("gpt-5.6-terra · 1234 ms");
    const failed = records.detail({ source: "sdk", id: calls[0]!.id })!;
    expect(failed.fields).toEqual(
      expect.arrayContaining([
        { label: "model", value: "gpt-5.6-terra" },
        { label: "attempt", value: "1 / 3" },
        { label: "status", value: 429 },
      ]),
    );
    expect(failed.blocks.map((b) => b.label)).toEqual(["request", "error"]);
    expect(records.query({ level: "attention" }).rows.map((r) => r.title)).toEqual(["chat failed"]);
    records.close();
  });

  it("finds text literally, filters by launch and chat, and pages from newest to oldest", () => {
    const { file, logs } = fresh();
    const first = openRecords(file, logs, "launch-1", "1");
    first.log("info", "app.start", { note: "100%_literal" });
    first.close();
    const records = openRecords(file, logs, "launch-2", "1");
    for (let i = 0; i < 150; i++) {
      records.sdkEvent({ id: i % 2 ? "chat-a" : "chat-b", folder: "f" }, { time: `2026-10-19T01:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, level: "info", event: "verb.start", message: `n${i}` });
    }
    expect(records.query({ search: "100%_lit" }).rows.map((r) => r.title)).toEqual(["app.start"]);
    expect(records.query({ search: "100%x" }).rows).toEqual([]);
    expect(records.query({ launch: "launch-1" }).rows).toHaveLength(1);
    expect(records.launches().map((l) => [l.id, l.current])).toEqual([
      ["launch-2", true],
      ["launch-1", false],
    ]);
    const page = records.query({ launch: "launch-2" });
    expect(page.rows).toHaveLength(100);
    expect(page.rows[0]!.text).toBe("n149");
    const next = records.query({ launch: "launch-2", cursor: page.next! });
    expect(next.rows).toHaveLength(50);
    expect(next.next).toBeNull();
    expect(records.query({ chatId: "chat-a" }).rows.every((r) => r.chatId === "chat-a")).toBe(true);
    records.close();
  });

  it("tells a listener after each stored record", () => {
    const { file, logs } = fresh();
    const records = openRecords(file, logs, "l", "1");
    const listener = vi.fn();
    records.onChange(listener);
    records.log("info", "app.start");
    records.sdkEvent(null, { level: "info", event: "verb.start" });
    expect(listener).toHaveBeenCalledTimes(2);
    records.close();
  });

  it("contains a throwing change listener and still notifies later listeners", () => {
    const { file, logs } = fresh();
    const records = openRecords(file, logs, "launch", "1");
    const failure = new Error("listener unavailable");
    vi.spyOn(console, "error").mockImplementation(() => {});
    records.onChange(() => { throw failure; });
    const later = vi.fn();
    records.onChange(later);
    expect(() => records.log("info", "app.start")).not.toThrow();
    expect(later).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("[gptimg] records listener failed", failure);
    expect(records.query({})).toMatchObject({ failed: false, rows: [{ title: "app.start" }] });
    records.close();
  });

  it("leaves an unsupported old schema and rows untouched, closes it, and uses fallback", () => {
    const { file, logs } = fresh();
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE log (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, at_utc TEXT NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, fields TEXT)");
    old.prepare("INSERT INTO log (session_id, at_utc, level, event) VALUES ('old', '2026-01-01T00:00:00.000Z', 'info', 'app.start')").run();
    const before = old.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table'").all();
    old.close();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const closed = vi.spyOn(DatabaseSync.prototype, "close");
    const records = openRecords(file, logs, "new", "1");
    expect(closed).toHaveBeenCalledOnce();
    records.log("info", "app.quit");
    expect(records.query({})).toEqual({ rows: [], next: null, failed: true });
    const check = new DatabaseSync(file);
    expect(check.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table'").all()).toEqual(before);
    expect(check.prepare("SELECT session_id, event FROM log").all()).toEqual([{ session_id: "old", event: "app.start" }]);
    check.close();
    records.close();
  });

  it("keeps a failed-write diagnostic, notifies listeners, and marks readable queries incomplete", () => {
    const { file, logs } = fresh();
    const records = openRecords(file, logs, "launch", "1");
    records.log("info", "app.start");
    const control = new DatabaseSync(file);
    control.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON sdk_events BEGIN SELECT RAISE(FAIL, 'test store write failure'); END");
    const listener = vi.fn();
    records.onChange(listener);
    const chat = { id: "chat-a", folder: "/chosen/chat" };
    const event = { event: "attempt.retrying", level: "warn", request: { authorization: "[REDACTED]" } };
    records.sdkEvent(chat, event);
    expect(listener).toHaveBeenCalledOnce();
    const line = JSON.parse(readFileSync(join(logs, readdirSync(logs)[0]!), "utf8").trim());
    expect(line).toMatchObject({ chat, body: event, storageError: { name: "Error", message: "test store write failure", code: "ERR_SQLITE_ERROR", stack: expect.any(String) } });
    expect(event.request.authorization).toBe("[REDACTED]");
    expect(records.query({})).toMatchObject({ failed: true, rows: [{ title: "app.start" }] });
    control.exec("DROP TRIGGER refuse_event");
    records.sdkEvent(chat, { event: "verb.start", level: "info" });
    expect(records.query({})).toMatchObject({ failed: true });
    expect(records.query({}).rows).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(2);
    control.close();
    records.close();
  });

  it("classifies a retrying attempt as a call with its request and error details", () => {
    const { file, logs } = fresh();
    const records = openRecords(file, logs, "launch", "1");
    const event = attempt("attempt.retrying", "2026-10-19T00:00:03.000Z", { error: { code: "rate_limit" }, status: 429 });
    records.sdkEvent({ id: "chat", folder: "folder" }, event);
    const calls = records.query({ kind: "call" }).rows;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ title: "chat retrying", kind: "call" });
    expect(records.query({ kind: "log" }).rows).toEqual([]);
    const detail = records.detail({ source: "sdk", id: calls[0]!.id })!;
    expect(detail).toMatchObject({ kind: "call", title: "chat retrying" });
    expect(detail.blocks.map((block) => block.label)).toEqual(["request", "error"]);
    expect(JSON.parse(detail.blocks[0]!.text)).toEqual(event.request);
    expect(JSON.parse(detail.blocks[1]!.text)).toEqual(event.error);
    records.close();
  });

  it("falls back to a JSON line under logs/ when the database cannot be opened", () => {
    const { dir, logs } = fresh();
    const notADatabase = join(dir, "records.sqlite3");
    writeFileSync(notADatabase, "this is not sqlite");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const records = openRecords(notADatabase, logs, "launch-x", "1");
    records.log("warn", "settings.saveFailed", { error: "disk" });
    expect(records.query({})).toMatchObject({ failed: true });
    const [file] = readdirSync(logs);
    expect(file).toMatch(/^\d{8}-\d{6}-utc\.log$/);
    const line = JSON.parse(readFileSync(join(logs, file!), "utf8").trim());
    expect(line).toMatchObject({ session: "launch-x", level: "warn", event: "settings.saveFailed", message: APP_EVENTS["settings.saveFailed"], fields: { error: "disk" } });
    expect(existsSync(logs)).toBe(true);
  });
});
