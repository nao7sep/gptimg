import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startStores, type Stores } from "../../src/main/stores.ts";

// The real store worker on its own thread, as the app runs it, over real databases.

const directories: string[] = [];
const started: Stores[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((stores) => stores.close({ drain: false })));
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(): { stores: Stores; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gptimg-stores-"));
  directories.push(dir);
  const stores = startStores({
    recordsPath: join(dir, "records.sqlite3"), logsDir: join(dir, "logs"), backupsPath: join(dir, "backups.sqlite3"),
    sessionId: "launch-1", version: "1.0.0",
  });
  started.push(stores);
  return { stores, dir };
}

function rows(file: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file);
  try { return db.prepare(sql).all() as Record<string, unknown>[]; } finally { db.close(); }
}

describe("stores", () => {
  it("answers a read after the writes posted before it, and signals each record", async () => {
    const { stores } = fresh();
    let changes = 0;
    stores.records.onChange(() => { changes += 1; });
    stores.records.log("info", "turn.sent", { chatId: "chat-a" });
    stores.records.log("warn", "turn.failed", { chatId: "chat-a" });
    const page = await stores.records.query({});
    expect(page.rows.map((row) => row.title)).toEqual(["turn.failed", "turn.sent"]);
    expect((await stores.records.launches()).map((launch) => launch.id)).toEqual(["launch-1"]);
    expect(await stores.records.detail({ source: "app", id: page.rows[0]!.id })).toMatchObject({ kind: "log", launchId: "launch-1" });
    expect(changes).toBe(2);
  });

  it("writes what is pending before an ordinary close, and nothing after it", async () => {
    const { stores, dir } = fresh();
    stores.records.log("info", "app.quit");
    stores.backups.keep(join(dir, "config.json"), "saved");
    await stores.close({ drain: true });
    stores.records.log("info", "app.start");
    stores.backups.keep(join(dir, "config.json"), "past the exit");
    await expect(stores.records.query({})).rejects.toThrow("closed");

    expect(rows(join(dir, "records.sqlite3"), "SELECT event FROM log")).toEqual([{ event: "app.quit" }]);
    expect(rows(join(dir, "backups.sqlite3"), "SELECT CAST(content AS TEXT) AS content FROM backups")).toEqual([{ content: "saved" }]);
  });
});
