import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBackups } from "../../src/main/backups.ts";

describe("backups", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gptimg-backups-"));
    file = join(dir, "backups.sqlite3");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores exact UTF-8 bytes, hash, size and absolute path, replacing only this launch's row", () => {
    const onError = vi.fn();
    const target = join(dir, "chosen", "document.json");
    const original = "first\n\u65e5\u672c\u8a9e";
    const latest = '{"title":"\u00e9\u672c","text":"line\\nline"}\n';
    const first = openBackups(file, "first", onError);
    first.keep(target, original);
    first.keep(target, latest);
    first.close();
    const second = openBackups(file, "second", onError);
    second.keep(target, "later launch");
    second.close();
    const db = new DatabaseSync(file);
    const rows = db.prepare("SELECT * FROM backups ORDER BY session_id").all();
    expect(rows).toHaveLength(2);
    for (const [index, content] of [latest, "later launch"].entries()) {
      const bytes = Buffer.from(content, "utf8");
      expect(rows[index]).toMatchObject({
        session_id: index === 0 ? "first" : "second",
        path: target,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byte_size: bytes.byteLength,
      });
      expect(Buffer.from(rows[index]!.content as Uint8Array)).toEqual(bytes);
      expect(rows[index]!.written_at_utc).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
    db.close();
    expect(onError).not.toHaveBeenCalled();
  });

  it("closes an unsupported database after preparation fails without changing its contents", () => {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE backups (path TEXT PRIMARY KEY, content TEXT)");
    old.prepare("INSERT INTO backups VALUES (?, ?)").run("keep", "original");
    old.close();
    const onError = vi.fn();
    const closed = vi.spyOn(DatabaseSync.prototype, "close");
    const backups = openBackups(file, "launch", onError);
    expect(closed).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining("not a GptImg backups database") });
    expect(() => backups.keep(join(dir, "doc"), "new")).not.toThrow();
    backups.close();
    const check = new DatabaseSync(file);
    expect(check.prepare("SELECT * FROM backups").all()).toEqual([{ path: "keep", content: "original" }]);
    expect(check.prepare("PRAGMA table_info(backups)").all().map((column) => column.name)).toEqual(["path", "content"]);
    check.close();
  });

  it("reports invalid database startup without throwing or replacing its file", () => {
    writeFileSync(file, "not sqlite");
    const onError = vi.fn();
    const backups = openBackups(file, "launch", onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(() => backups.keep(join(dir, "doc"), "new")).not.toThrow();
    expect(readFileSync(file, "utf8")).toBe("not sqlite");
    backups.close();
  });

  it("reports a real write failure without throwing through the primary save", () => {
    const onError = vi.fn();
    const backups = openBackups(file, "launch", onError);
    const control = new DatabaseSync(file);
    control.exec("CREATE TRIGGER refuse_backup BEFORE INSERT ON backups BEGIN SELECT RAISE(FAIL, 'backup storage failed'); END");
    const primary = join(dir, "document.json");
    expect(() => {
      writeFileSync(primary, "saved primary");
      backups.keep(primary, "saved primary");
    }).not.toThrow();
    expect(readFileSync(primary, "utf8")).toBe("saved primary");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "ERR_SQLITE_ERROR", message: "backup storage failed" }));
    expect(control.prepare("SELECT * FROM backups").all()).toEqual([]);
    control.close();
    backups.close();
  });

  it("keeps backup failure best effort even when its diagnostic callback throws", () => {
    writeFileSync(file, "not sqlite");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => openBackups(file, "launch", () => { throw new Error("diagnostic unavailable"); })).not.toThrow();
    expect(console.error).toHaveBeenCalledWith("[gptimg] backup diagnostic failed", expect.any(Error), expect.objectContaining({ message: "diagnostic unavailable" }));
  });
});
