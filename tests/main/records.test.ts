import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { APP_EVENTS, openRecords } from "../../src/main/records.ts";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "gptimg-records-"));
  return { file: join(dir, "records.sqlite3"), logs: join(dir, "logs"), dir };
};

const attempt = (event: string, at: string, extra: Record<string, unknown> = {}) => ({
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

  it("adds the columns a later version needs to a database an earlier one made", () => {
    const { file, logs } = fresh();
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE log (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, at_utc TEXT NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, fields TEXT)");
    old.prepare("INSERT INTO log (session_id, at_utc, level, event) VALUES ('old', '2026-01-01T00:00:00.000Z', 'info', 'app.start')").run();
    old.close();
    const records = openRecords(file, logs, "new", "1");
    records.log("info", "app.quit");
    expect(records.query({}).rows.map((r) => r.title)).toEqual(["app.quit", "app.start"]);
    records.close();
  });

  it("falls back to a JSON line under logs/ when the database cannot be opened", () => {
    const { dir, logs } = fresh();
    const notADatabase = join(dir, "records.sqlite3");
    writeFileSync(notADatabase, "this is not sqlite");
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
