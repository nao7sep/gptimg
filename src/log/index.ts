import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { LocalOpError } from "../errors.js";
import { redact } from "../profile/redact.js";
import type { LogEntry, LogHandle, LogLevel, LogStage, LogVerb } from "../types.js";

export async function openLog(filePath: string, verb: LogVerb): Promise<LogHandle> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
  } catch (err) {
    throw new LocalOpError(
      "log.openFailed",
      `Failed to open log at ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
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
  onEvent?: (entry: LogEntry) => void,
): Promise<void> {
  const final: LogEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    verb: entry.verb ?? handle.verb,
    level: entry.level,
    stage: entry.stage,
    msg: entry.msg,
  };
  if (entry.data) final.data = redact(entry.data);
  // Fan out progress before the file write so a caller watching live sees the
  // event immediately. Only info/warn are progress; error is a failure that the
  // caller learns about through the thrown error, not the progress stream.
  // Best-effort: a throwing callback must never break the operation.
  if (onEvent && (final.level === "info" || final.level === "warn")) {
    try {
      onEvent(final);
    } catch {
      // ignore — progress is advisory
    }
  }
  try {
    await appendFile(handle.path, JSON.stringify(final) + "\n", "utf-8");
  } catch (err) {
    throw new LocalOpError(
      "log.writeFailed",
      `Failed to write log at ${handle.path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
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

export async function createLogger(
  filePath: string,
  verb: LogVerb,
  opts: { onEvent?: (entry: LogEntry) => void } = {},
): Promise<Logger> {
  const handle = await openLog(filePath, verb);
  const onEvent = opts.onEvent;
  return {
    handle,
    info: (stage, msg, data) => appendLog(handle, { level: "info", stage, msg, data }, onEvent),
    warn: (stage, msg, data) => appendLog(handle, { level: "warn", stage, msg, data }, onEvent),
    error: (stage, msg, data) => appendLog(handle, { level: "error", stage, msg, data }, onEvent),
    close: () => closeLog(handle),
  };
}

export async function safeLogError(
  logger: Pick<Logger, "error">,
  msg: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await logger.error("error", msg, data);
  } catch {
    // Preserve the original error; logging is best-effort on failure paths.
  }
}
