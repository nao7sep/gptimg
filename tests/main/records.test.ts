import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { APP_EVENTS, openRecords } from "../../src/main/records.ts";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "gptimg-records-"));
  return { file: join(dir, "records.sqlite3"), logs: join(dir, "logs"), dir };
};

describe("records", () => {
  it("keeps each log line with its fixed message, its launch and its chat", () => {
    const { file, logs } = fresh();
    const records = openRecords(file, logs, "launch-1", "1.0.0");
    records.log("info", "turn.sent", { chatId: "chat-a", turnId: "t1" });
    const page = records.query({ kind: "log", scope: "launch" });
    expect(page.rows[0]).toMatchObject({ event: "turn.sent", summary: APP_EVENTS["turn.sent"], chatId: "chat-a", level: "info" });
    expect(records.detail("log", page.rows[0]!.id)?.body).toEqual({ chatId: "chat-a", turnId: "t1" });
    records.close();
  });

  it("filters by launch and chat and pages from newest to oldest", () => {
    const { file, logs } = fresh();
    const first = openRecords(file, logs, "launch-1", "1");
    first.log("info", "app.start");
    first.close();
    const records = openRecords(file, logs, "launch-2", "1");
    for (let i = 0; i < 205; i++) records.sdkEvent({ id: i % 2 ? "chat-a" : "chat-b", folder: "f" }, { level: "info", event: "verb.start", message: `n${i}` });
    expect(records.query({ kind: "log", scope: "launch" }).rows).toHaveLength(0);
    expect(records.query({ kind: "log", scope: "all" }).rows).toHaveLength(1);
    const page = records.query({ kind: "events", scope: "launch" });
    expect(page.rows).toHaveLength(200);
    expect(page.more).toBe(true);
    expect(page.rows[0]!.summary).toBe("n204");
    const next = records.query({ kind: "events", scope: "launch", beforeId: page.rows[199]!.id });
    expect(next).toMatchObject({ more: false });
    expect(next.rows).toHaveLength(5);
    expect(records.query({ kind: "events", scope: "all", chatId: "chat-a" }).rows.every((r) => r.chatId === "chat-a")).toBe(true);
    records.close();
  });

  it("records a turn with its tokens for the calls view", () => {
    const { file, logs } = fresh();
    const records = openRecords(file, logs, "l", "1");
    records.turn({ chatId: "c", sessionFolder: "f", turnId: "t", model: "gpt-x", status: "completed", responseId: "r", inputTokens: 5, outputTokens: 7, body: { id: "r" } });
    expect(records.query({ kind: "calls", scope: "launch" }).rows[0]).toMatchObject({ event: "completed", summary: "gpt-x", tokens: { input: 5, output: 7 } });
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
    expect(records.query({ kind: "log", scope: "all" }).rows.map((r) => r.event)).toEqual(["app.quit", "app.start"]);
    records.close();
  });

  it("falls back to a JSON line under logs/ when the database cannot be opened", () => {
    const { dir, logs } = fresh();
    const notADatabase = join(dir, "records.sqlite3");
    writeFileSync(notADatabase, "this is not sqlite");
    const records = openRecords(notADatabase, logs, "launch-x", "1");
    records.log("warn", "settings.saveFailed", { error: "disk" });
    expect(records.query({ kind: "log", scope: "launch" })).toMatchObject({ unavailable: true });
    const [file] = readdirSync(logs);
    expect(file).toMatch(/^\d{8}-\d{6}-utc\.log$/);
    const line = JSON.parse(readFileSync(join(logs, file!), "utf8").trim());
    expect(line).toMatchObject({ session: "launch-x", level: "warn", event: "settings.saveFailed", message: APP_EVENTS["settings.saveFailed"], fields: { error: "disk" } });
    expect(existsSync(join(logs))).toBe(true);
  });
});
