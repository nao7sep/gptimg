// Main forwards store work without running SQLite or hashing on its event loop.
// One message is active at a time; pending backups coalesce by path, and reads
// never bypass earlier accepted writes. Physical ownership ends at worker exit.
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { AppPaths } from "./paths.ts";
import type { Records } from "./records.ts";
import type { Backups } from "./backups.ts";
import type { LaunchEntry, RecordDetail, RecordQuery, RecordRef, RecordsPage } from "../shared/records.ts";

type Job = { id: number; method: string; args: unknown[]; resolve: (value: unknown) => void; reject: (error: Error) => void };
export type RecordWriter = Pick<Records, "sessionId" | "log" | "sdkEvent" | "turn" | "onChange">;
export interface AsyncRecords extends RecordWriter {
  launches(): Promise<LaunchEntry[]>;
  query(query: RecordQuery): Promise<RecordsPage>;
  detail(ref: RecordRef): Promise<RecordDetail | null>;
  close(): void;
}

export class StoreHost {
  readonly records: AsyncRecords;
  readonly backups: Backups;
  readonly #worker: Worker;
  readonly #queue: Job[] = [];
  readonly #listeners = new Set<() => void>();
  #active: Job | null = null;
  #serial = 0;
  #failed: Error | null = null;
  #closing = false;
  #degraded = false;
  readonly #capacity = availableParallelism() * 64;
  readonly #exited: Promise<void>;

  constructor(entry: string | URL, paths: AppPaths, sessionId: string, version: string) {
    this.#worker = new Worker(entry, { workerData: { paths, sessionId, version } });
    this.#worker.unref();
    this.#exited = new Promise((resolve) => this.#worker.once("exit", () => resolve()));
    this.#worker.on("message", (reply: { id?: number; changed?: boolean; value?: unknown; error?: string }) => {
      if (reply.changed) { this.#notify(); return; }
      const job = this.#active;
      if (!job || reply.id !== job.id) return;
      this.#active = null;
      if (reply.error) job.reject(new Error(reply.error)); else job.resolve(reply.value);
      this.#pump();
    });
    this.#worker.on("error", (error) => this.#fail(error instanceof Error ? error : new Error(String(error))));
    this.#worker.on("exit", (code) => this.#fail(new Error(`Store worker exited (${code})`)));
    const write = (method: string, args: unknown[]) => {
      void this.#call(method, args).catch((error) => {
        this.#degraded = true;
        console.error("[gptimg] store write unavailable", { method, args, error });
        this.#notify();
      });
    };
    this.records = {
      sessionId,
      log: (...args) => write("log", args),
      sdkEvent: (...args) => write("sdkEvent", args),
      turn: (...args) => write("turn", args),
      onChange: (listener) => { this.#listeners.add(listener); },
      launches: () => this.#call("launches", []).then((v) => v as LaunchEntry[]).catch(() => []),
      query: (query) => this.#call("query", [query]).then((v) => ({ ...v as RecordsPage, ...(this.#degraded && { failed: true }) })).catch(() => ({ rows: [], next: null, failed: true })),
      detail: (ref) => this.#call("detail", [ref]).then((v) => v as RecordDetail | null).catch(() => null),
      close: () => this.close(),
    };
    this.backups = {
      keep: (path, content) => {
        const pending = this.#queue.find((job) => job.method === "keep" && job.args[0] === path);
        if (pending) pending.args[1] = content;
        else write("keep", [path, content]);
      },
      close: () => this.close(),
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try { listener(); } catch (error) { console.error("[gptimg] store listener failed", error); }
    }
  }

  #call(method: string, args: unknown[]): Promise<unknown> {
    if (this.#failed || this.#closing) return Promise.reject(this.#failed ?? new Error("Stores closing"));
    // Diagnostic hooks cannot block the provider. Bound their waiting backlog;
    // overload is an explicit degraded record store, with full evidence on stderr.
    // This limits pending messages, never conversations or stored history.
    if (method !== "close" && this.#queue.length >= this.#capacity) return Promise.reject(new Error("Store worker backlog is full"));
    return new Promise((resolve, reject) => {
      this.#queue.push({ id: ++this.#serial, method, args, resolve, reject });
      this.#pump();
    });
  }
  #pump(): void {
    if (this.#active || this.#failed) return;
    this.#active = this.#queue.shift() ?? null;
    if (this.#active) {
      const { id, method, args } = this.#active;
      try { this.#worker.postMessage({ id, method, args }); }
      catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); }
    }
  }
  #fail(error: Error): void {
    this.#failed = error;
    this.#active?.reject(error);
    this.#active = null;
    for (const job of this.#queue.splice(0)) job.reject(error);
    this.#notify();
  }
  close(): Promise<void> {
    if (this.#closing) return this.#exited;
    void this.#call("close", []).catch(() => {});
    this.#closing = true;
    // Optional history gets a short ordinary-exit drain; it cannot hold OS exit.
    const timer = setTimeout(() => { void this.#worker.terminate(); }, 2000);
    timer.unref();
    this.#worker.once("exit", () => clearTimeout(timer));
    return this.#exited;
  }
}
