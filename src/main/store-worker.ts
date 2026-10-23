// All SQLite, hashing and fallback disk work belongs to this serial worker.
import { parentPort, workerData } from "node:worker_threads";
import { openRecords } from "./records.ts";
import { openBackups } from "./backups.ts";
import type { RecordQuery, RecordRef } from "../shared/records.ts";

const { paths, sessionId, version } = workerData;
const records = openRecords(paths.records, paths.logs, sessionId, version);
const backups = openBackups(paths.backups, sessionId, (error) => records.log("warn", "backups.failed", { error: String(error) }));
records.onChange(() => parentPort!.postMessage({ changed: true }));
parentPort!.on("message", (request: { id: number; method: string; args: unknown[] }) => {
  try {
    let value: unknown;
    switch (request.method) {
      case "log": records.log(...request.args as Parameters<typeof records.log>); break;
      case "sdkEvent": records.sdkEvent(...request.args as Parameters<typeof records.sdkEvent>); break;
      case "turn": records.turn(...request.args as Parameters<typeof records.turn>); break;
      case "keep": backups.keep(...request.args as Parameters<typeof backups.keep>); break;
      case "launches": value = records.launches(); break;
      case "query": value = records.query(request.args[0] as RecordQuery); break;
      case "detail": value = records.detail(request.args[0] as RecordRef); break;
      case "close": backups.close(); records.close(); break;
      default: throw new Error("Unknown store operation");
    }
    parentPort!.postMessage({ id: request.id, value });
    if (request.method === "close") parentPort!.close();
  } catch (error) { parentPort!.postMessage({ id: request.id, error: String(error) }); }
});
