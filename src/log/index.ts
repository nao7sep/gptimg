import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redact } from "../profile/redact.js";
import type { LogEntry, LogHandle, LogLevel, LogStage, LogVerb } from "../types.js";

export async function openLog(filePath: string, verb: LogVerb): Promise<LogHandle> {
  await mkdir(path.dirname(filePath), { recursive: true });
  return { path: filePath, verb };
}

export async function appendLog(
  handle: LogHandle,
  entry: {
    level: LogLevel;
    stage: LogStage;
    msg: string;
    data?: Record<string, unknown>;
    verb?: LogVerb;
    ts?: string;
  },
): Promise<void> {
  const final: LogEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    verb: entry.verb ?? handle.verb,
    level: entry.level,
    stage: entry.stage,
    msg: entry.msg,
  };
  if (entry.data) final.data = redact(entry.data);
  await appendFile(handle.path, JSON.stringify(final) + "\n", "utf-8");
}

export async function closeLog(_handle: LogHandle): Promise<void> {
  // No persistent file descriptor in this implementation; nothing to release.
}

export interface Logger {
  readonly handle: LogHandle;
  info(stage: LogStage, msg: string, data?: Record<string, unknown>): Promise<void>;
  warn(stage: LogStage, msg: string, data?: Record<string, unknown>): Promise<void>;
  error(stage: LogStage, msg: string, data?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export async function createLogger(filePath: string, verb: LogVerb): Promise<Logger> {
  const handle = await openLog(filePath, verb);
  return {
    handle,
    info: (stage, msg, data) => appendLog(handle, { level: "info", stage, msg, data }),
    warn: (stage, msg, data) => appendLog(handle, { level: "warn", stage, msg, data }),
    error: (stage, msg, data) => appendLog(handle, { level: "error", stage, msg, data }),
    close: () => closeLog(handle),
  };
}
