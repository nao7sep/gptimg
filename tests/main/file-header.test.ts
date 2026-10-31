import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { readChat, writeChat } from "../../src/main/chats.ts";
import { APP_WRITER, claimDatabase, readHeader, withHeader } from "../../src/main/file-header.ts";
import { openRecords } from "../../src/main/records.ts";
import manifest from "../../package.json" with { type: "json" };

const format = (kind: unknown = "chat", version: unknown = 1, owner: unknown = "gptimg") => ({ owner, kind, version });

describe("the JSON header", () => {
  it("opens the file with format then writer, naming this app's package and version", () => {
    const written = withHeader("state", { railWidth: 300, format: "stale", writer: "stale" });
    expect(Object.keys(written)).toEqual(["format", "writer", "railWidth"]);
    expect(written).toEqual({ format: { owner: "gptimg", kind: "state", version: 1 }, writer: { name: manifest.name, version: manifest.version }, railWidth: 300 });
    expect(APP_WRITER).toEqual({ name: "gptimg", version: manifest.version });
  });

  it("reads the content of a file of this owner, kind and version", () => {
    expect(readHeader({ format: format(), writer: APP_WRITER, title: "t" }, "chat")).toEqual({ kind: "ok", body: { title: "t" } });
  });

  it("refuses a missing or malformed header, another owner and another kind", () => {
    for (const parsed of [
      { title: "t" },
      { format: 1, title: "t" },
      { format: "gptimg.chat", title: "t" },
      { format: format("chat", 1, "fotoready"), title: "t" },
      { format: format("config"), title: "t" },
      { format: format("chat", 0), title: "t" },
      { format: format("chat", 1.5), title: "t" },
      { format: format("chat", "1"), title: "t" },
      { format: { owner: "gptimg", kind: "chat" }, title: "t" },
      null,
      [],
    ]) expect(readHeader(parsed, "chat")).toEqual({ kind: "unreadable" });
  });

  it("tells a newer version apart", () => {
    expect(readHeader({ format: format("chat", 2), title: "t" }, "chat")).toEqual({ kind: "newer", version: 2 });
  });

  it("never reads the writer", () => {
    for (const writer of [undefined, null, "x", { name: "someone", version: 9 }]) {
      expect(readHeader({ format: format(), ...(writer !== undefined && { writer }), title: "t" }, "chat")).toEqual({ kind: "ok", body: { title: "t" } });
    }
  });
});

describe("chat.json", () => {
  const doc = { id: "c1", title: "t", createdAt: "2026-10-19T00:00:00.000Z", turns: [] };

  it("is written with its header and read back without it", async () => {
    const root = mkdtempSync(join(tmpdir(), "gptimg-header-"));
    mkdirSync(join(root, "a"));
    await writeChat(root, "a", doc);
    expect(Object.keys(JSON.parse(readFileSync(join(root, "a", "chat.json"), "utf8"))).slice(0, 3)).toEqual(["format", "writer", "id"]);
    expect(await readChat(root, "a")).toEqual(doc);
  });

  it("is malformed without a chat header or with a newer version, and is left as it is", async () => {
    const root = mkdtempSync(join(tmpdir(), "gptimg-header-"));
    mkdirSync(join(root, "a"));
    for (const text of [JSON.stringify({ format: 1, ...doc }), JSON.stringify({ format: format("config"), ...doc }), JSON.stringify({ format: format("chat", 2), ...doc })]) {
      writeFileSync(join(root, "a", "chat.json"), text);
      await expect(readChat(root, "a")).rejects.toMatchObject({ code: "malformed" });
      expect(readFileSync(join(root, "a", "chat.json"), "utf8")).toBe(text);
    }
  });
});

describe("the SQLite header", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "gptimg-header-")), "store.sqlite3");
  const claim = (file: string, kind: "records" | "backups") => {
    const db = new DatabaseSync(file);
    try {
      db.exec("BEGIN");
      claimDatabase(db, kind);
      db.exec("COMMIT");
    } catch (error) {
      db.close();
      throw error;
    }
    db.close();
  };
  const rows = (file: string) => {
    const db = new DatabaseSync(file);
    const out = { version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, header: Object.fromEntries((db.prepare("SELECT key, value FROM file_header ORDER BY key").all() as { key: string; value: string }[]).map((r) => [r.key, r.value])) };
    db.close();
    return out;
  };

  it("gives a new empty database version 1 and its header rows", () => {
    const file = fresh();
    claim(file, "backups");
    expect(rows(file)).toEqual({ version: 1, header: { "format.kind": "backups", "format.owner": "gptimg", "writer.name": "gptimg", "writer.version": manifest.version } });
  });

  it("rewrites the writer rows on open and accepts any writer", () => {
    const file = fresh();
    claim(file, "records");
    const db = new DatabaseSync(file);
    db.exec("UPDATE file_header SET value = 'someone' WHERE key = 'writer.name'");
    db.exec("DELETE FROM file_header WHERE key = 'writer.version'");
    db.close();
    claim(file, "records");
    expect(rows(file).header["writer.name"]).toBe("gptimg");
    expect(rows(file).header["writer.version"]).toBe(manifest.version);
  });

  it("refuses another kind, a database without a header, and a newer version, changing nothing", () => {
    const backups = fresh();
    claim(backups, "backups");
    expect(() => claim(backups, "records")).toThrow("not a GptImg records database");

    const bare = fresh();
    const db = new DatabaseSync(bare);
    db.exec("CREATE TABLE t (x)");
    db.close();
    expect(() => claim(bare, "records")).toThrow("not a GptImg records database");

    const newer = fresh();
    claim(newer, "records");
    const raise = new DatabaseSync(newer);
    raise.exec("PRAGMA user_version = 2");
    raise.close();
    expect(() => claim(newer, "records")).toThrow("newer than 1");
    expect(rows(newer).version).toBe(2);
  });

  it("puts the records store in its fallback when the header names another kind", () => {
    const file = fresh();
    claim(file, "backups");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const records = openRecords(file, join(file, "..", "logs"), "launch", "1");
    expect(records.query({})).toEqual({ rows: [], next: null, failed: true });
    records.close();
    vi.restoreAllMocks();
    expect(rows(file).header["format.kind"]).toBe("backups");
  });
});
