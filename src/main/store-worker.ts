// The owner of records.sqlite3 and backups.sqlite3, off the main process
// (rejected-mechanisms-conventions, Synchronous stores on the interface thread):
// one connection to each, and every write and Records read answered in the order
// it arrives. The main process posts and never waits on a write (stores.ts). The
// tests run this source under Node's type stripping, so its imports are relative
// and spelled with their extension.
import { parentPort, workerData } from "node:worker_threads";
import { openBackups } from "./backups.ts";
import { openRecords, type AppEvent, type LogLevel, type TurnRecord } from "./records.ts";
import type { RecordQuery, RecordRef } from "../shared/records.ts";

export interface StoreWorkerData {
  recordsPath: string;
  logsDir: string;
  backupsPath: string;
  sessionId: string;
  version: string;
}

export type StoreRead = { op: "launches" } | { op: "query"; query: RecordQuery } | { op: "detail"; ref: RecordRef };

export type StoreRequest =
  | { kind: "log"; level: LogLevel; event: AppEvent; fields?: Record<string, unknown> }
  | { kind: "sdkEvent"; chat: { id: string; folder: string } | null; event: Record<string, unknown> }
  | { kind: "turn"; record: TurnRecord }
  | { kind: "backup"; path: string; content: string }
  | { kind: "read"; id: number; read: StoreRead }
  | { kind: "close" };

export type StoreResponse =
  | { kind: "changed" }
  | { kind: "read"; id: number; ok: true; value: unknown }
  | { kind: "read"; id: number; ok: false; error: string }
  | { kind: "closed" };

if (parentPort === null) throw new Error("The store worker needs a parent port.");
const port = parentPort;
const data = workerData as StoreWorkerData;
const records = openRecords(data.recordsPath, data.logsDir, data.sessionId, data.version);
const backups = openBackups(data.backupsPath, data.sessionId, (error) => records.log("warn", "backups.failed", { error: String(error) }));
records.onChange(() => port.postMessage({ kind: "changed" } satisfies StoreResponse));

function read(request: StoreRead): unknown {
  if (request.op === "launches") return records.launches();
  if (request.op === "query") return records.query(request.query);
  return records.detail(request.ref);
}

port.on("message", (request: StoreRequest) => {
  switch (request.kind) {
    case "log": records.log(request.level, request.event, request.fields); return;
    case "sdkEvent": records.sdkEvent(request.chat, request.event); return;
    case "turn": records.turn(request.record); return;
    case "backup": backups.keep(request.path, request.content); return;
    case "read": {
      let response: StoreResponse;
      try {
        response = { kind: "read", id: request.id, ok: true, value: read(request.read) };
      } catch (error) {
        response = { kind: "read", id: request.id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
      port.postMessage(response);
      return;
    }
    case "close":
      backups.close();
      records.close();
      port.postMessage({ kind: "closed" } satisfies StoreResponse);
  }
});
