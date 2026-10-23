import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { StoreHost } from "../../src/main/store-host.ts";
import { pathsUnder, type AppPaths } from "../../src/main/paths.ts";

// Build the real production worker, including its SQLite owners, as Node loads
// JavaScript rather than Vitest's transformed TypeScript in a worker thread.
const workerSource = fileURLToPath(new URL("../../src/main/store-worker.ts", import.meta.url));
let built: string;
let entry: string;
let blockedEntry: string;
async function bundle(source: string, name: string): Promise<string> {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: built,
      emptyOutDir: false,
      target: "node24",
      minify: false,
      lib: { entry: source, formats: ["es"], fileName: () => name },
      rollupOptions: { external: [/^node:/] },
    },
  });
  return join(built, name);
}

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), "gptimg-store-worker-build-"));
  entry = await bundle(workerSource, "store-worker.mjs");
  const bootstrap = join(built, "blocked-worker.mjs");
  // The instrumentation only announces an imminent real SQLite INSERT and
  // enables its busy wait. All application dispatch and writes remain real.
  await writeFile(bootstrap, `
import { DatabaseSync } from 'node:sqlite';
import { parentPort } from 'node:worker_threads';
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  originalExec.call(this, 'PRAGMA busy_timeout = 10000');
  return originalExec.call(this, sql);
};
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = originalPrepare.call(this, sql);
  if (sql.startsWith('INSERT INTO log ')) {
    const run = statement.run;
    statement.run = function(...args) {
      parentPort.postMessage({ changed: true });
      return run.apply(this, args);
    };
  }
  return statement;
};
await import(${JSON.stringify(pathToFileURL(entry).href)});
`);
  blockedEntry = bootstrap;
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

describe("StoreHost with the real Node worker", () => {
  let dir: string;
  let paths: AppPaths;
  const hosts: StoreHost[] = [];
  const open = (worker = entry, sessionId = "launch") => {
    const host = new StoreHost(worker, paths, sessionId, "1.0.0");
    hosts.push(host);
    return host;
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gptimg-store-host-"));
    paths = pathsUnder(dir);
  });
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("runs accepted writes and reads in order and sends change notifications", async () => {
    const host = open();
    const changed = vi.fn();
    host.records.onChange(changed);
    host.records.log("info", "app.start", { note: "first" });
    const firstPage = host.records.query({});
    host.records.log("info", "app.quit", { note: "second" });
    expect((await firstPage).rows.map((row) => row.title)).toEqual(["app.start"]);
    const final = await host.records.query({});
    expect(final.failed).toBe(false);
    expect(final.rows.map((row) => row.title)).toEqual(["app.quit", "app.start"]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(await host.records.launches()).toMatchObject([{ id: "launch", current: true }]);
    expect(await host.records.detail({ source: "app", id: final.rows[0]!.id })).toMatchObject({ title: "app.quit", launchId: "launch" });
    await host.close();
    expect(await host.records.query({})).toEqual({ rows: [], next: null, failed: true });
  });

  it("reports query failure when the worker entry cannot start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const host = open(join(dir, "missing-worker.mjs"));
    host.records.log("error", "turn.failed", { chatId: "chat", error: "retained evidence" });
    expect(await host.records.query({})).toEqual({ rows: [], next: null, failed: true });
    expect(await host.records.launches()).toEqual([]);
    expect(await host.records.detail({ source: "app", id: 1 })).toBeNull();
    expect(console.error).toHaveBeenCalledWith("[gptimg] store write unavailable", expect.objectContaining({
      method: "log", args: ["error", "turn.failed", { chatId: "chat", error: "retained evidence" }], error: expect.any(Error),
    }));
  });

  it("stores the latest queued backup and preserves bytes across launches", async () => {
    const target = join(dir, "chosen-document.json");
    const latest = '{"text":"\u65e5\u672c\u8a9e"}\n';
    const first = open();
    first.backups.keep(target, "first");
    first.backups.keep(target, latest);
    await first.close();
    const second = open(entry, "later-launch");
    second.backups.keep(target, "later");
    await second.close();
    const db = new DatabaseSync(paths.backups);
    try {
      const rows = db.prepare("SELECT * FROM backups ORDER BY session_id").all();
      expect(rows).toHaveLength(2);
      for (const [index, content] of ["later", latest].entries()) {
        const bytes = Buffer.from(content);
        expect(rows[index]).toMatchObject({ path: target, byte_size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
        expect(Buffer.from(rows[index]!.content as Uint8Array)).toEqual(bytes);
      }
    } finally { db.close(); }
  });

  it("keeps the caller's event loop available while a worker waits on a SQLite write lock", async () => {
    const host = open(blockedEntry);
    await host.records.query({}); // Worker startup and schema preparation have settled.
    const lock = new DatabaseSync(paths.records);
    lock.exec("BEGIN IMMEDIATE");
    let waiting!: () => void;
    const writeIssued = new Promise<void>((resolve) => { waiting = resolve; });
    host.records.onChange(waiting);
    host.records.log("info", "app.start");
    const completed = vi.fn();
    const page = host.records.query({}).then((value) => { completed(); return value; });
    try {
      await writeIssued;
      // A real callback runs in this process while the other connection still
      // owns the write lock. No elapsed-time threshold stands in for isolation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).not.toHaveBeenCalled();
      expect(lock.isTransaction).toBe(true);
    } finally {
      lock.exec("COMMIT");
      lock.close();
    }
    expect(await page).toMatchObject({ failed: false, rows: [{ title: "app.start" }] });
  });
});
