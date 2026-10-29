// The main process's side of the store worker (store-worker.ts), which owns
// records.sqlite3 and backups.sqlite3 on its own thread. Writes are posted and
// never waited on; the Records window's reads are answered in turn with them.
import { Worker } from "node:worker_threads";
import type { LaunchEntry, RecordDetail, RecordQuery, RecordRef, RecordsPage } from "../shared/records.ts";
import type { Records } from "./records.ts";
import type { StoreRead, StoreRequest, StoreResponse, StoreWorkerData } from "./store-worker.ts";

export type StoreRecords = Pick<Records, "sessionId" | "log" | "sdkEvent" | "turn" | "onChange"> & {
  launches(): Promise<LaunchEntry[]>;
  query(query: RecordQuery): Promise<RecordsPage>;
  detail(ref: RecordRef): Promise<RecordDetail | null>;
};

export interface Stores {
  records: StoreRecords;
  backups: { keep(path: string, content: string): void };
  /**
   * Stops the worker. With `drain` (ordinary quit) every write posted before it
   * lands first, within what remains of the exit deadline; without it (OS
   * session end) they are skipped. Writes after it are past the exit and dropped.
   * Never rejects.
   */
  close(options: { drain: boolean }): Promise<void>;
}

export function startStores(data: StoreWorkerData): Stores {
  // The tests run the source under Node's type stripping; the app runs
  // electron-vite's store-worker.js entry beside the main bundle.
  const entry = import.meta.url.endsWith(".ts") ? "./store-worker.ts" : "./store-worker.js";
  const worker = new Worker(new URL(entry, import.meta.url), { workerData: data satisfies StoreWorkerData });
  worker.unref();

  let state: "open" | "closing" | "stopped" = "open";
  let nextId = 1;
  let closed: (() => void) | null = null;
  const reads = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  const listeners: (() => void)[] = [];

  const stop = (reason?: unknown): void => {
    if (state === "stopped") return;
    if (reason !== undefined) console.error("[gptimg] the store worker stopped; records go to the console", reason);
    state = "stopped";
    for (const read of reads.values()) read.reject(new Error("The stores are closed."));
    reads.clear();
    closed?.();
  };

  worker.on("message", (message: StoreResponse) => {
    if (message.kind === "closed") closed?.();
    else if (message.kind === "changed") {
      for (const listener of listeners) {
        try { listener(); } catch (error) { console.error("[gptimg] records listener failed", error); }
      }
    } else {
      const read = reads.get(message.id);
      if (!read) return;
      reads.delete(message.id);
      if (message.ok) read.resolve(message.value as never);
      else read.reject(new Error(message.error));
    }
  });
  worker.on("error", (error) => stop(error));
  worker.on("exit", (code) => stop(state === "open" ? new Error(`The store worker exited with code ${code}.`) : undefined));

  /** A record that cannot reach the worker goes to the console, so it is not lost silently. */
  const record = (request: StoreRequest): void => {
    if (state === "closing") return;
    if (state === "open") {
      try {
        worker.postMessage(request);
        return;
      } catch (error) {
        console.error("[gptimg] a record could not reach the store worker", error);
      }
    }
    console.error("[gptimg] record", request);
  };

  const ask = <T>(request: StoreRead): Promise<T> => {
    if (state !== "open") return Promise.reject(new Error("The stores are closed."));
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      reads.set(id, { resolve: resolve as (value: never) => void, reject });
      worker.postMessage({ kind: "read", id, read: request } satisfies StoreRequest);
    });
  };

  return {
    records: {
      sessionId: data.sessionId,
      log: (level, event, fields) => record({ kind: "log", level, event, fields }),
      sdkEvent: (chat, event) => record({ kind: "sdkEvent", chat, event }),
      turn: (turn) => record({ kind: "turn", record: turn }),
      launches: () => ask({ op: "launches" }),
      query: (query) => ask({ op: "query", query }),
      detail: (ref) => ask({ op: "detail", ref }),
      onChange: (listener) => { listeners.push(listener); },
    },
    backups: {
      keep(path, content) {
        if (state === "open") worker.postMessage({ kind: "backup", path, content } satisfies StoreRequest);
      },
    },
    async close({ drain }) {
      if (state === "open" && drain) {
        state = "closing";
        const done = new Promise<void>((resolve) => { closed = resolve; });
        worker.postMessage({ kind: "close" } satisfies StoreRequest);
        await done;
      }
      state = "closing";
      stop();
      await worker.terminate().catch(() => undefined);
    },
  };
}
