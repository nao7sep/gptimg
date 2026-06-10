import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redact } from "../profile/redact.js";
import type { LogEntry, LogHandle, LogLevel, LogStage, LogVerb } from "../types.js";

/**
 * `debug` logging is a developer-only firehose: it is written to the session log
 * file only when explicitly enabled, so it never floods an end-user's disk
 * (logging conventions). gptimg ships a single compiled artifact everywhere —
 * there is no separate "dev build" — so the one gate is the `GPTIMG_DEBUG`
 * environment variable. Accept the two forms a human reaches for (`1` / `true`,
 * case- and space-insensitive) so a mis-typed `true` is not a silent no-op. Read
 * per-call so a process that sets it late, or a test that toggles it, is honored.
 */
export function debugEnabled(): boolean {
  const v = process.env.GPTIMG_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Serialize one envelope to a single JSON Lines record (one object, newline-terminated). */
function serialize(entry: LogEntry): string {
  return JSON.stringify(entry) + "\n";
}

// Handles for which a file-logging failure has already been announced. We surface
// the failure to the console exactly ONCE per session rather than on every line:
// a dead log file degrades to a single notice, never a mirror of the whole stream
// onto the host's stderr (which, for an embedded SDK, would be its own misbehavior
// — imagine a server's disk filling and gptimg flooding its stderr). Module-private
// (a WeakSet, not a field) so the public LogHandle type stays a plain `{path, verb}`.
const failureAnnounced = new WeakSet<LogHandle>();

/**
 * Last-resort surface sanctioned by the logging convention's "when logging itself
 * fails": never crash, never silently swallow. Emit one warn-level record — built
 * and serialized through the SAME envelope path as a normal line — to the console,
 * once per handle. The live progress stream still carries non-error events, and
 * errors still reach the caller as thrown exceptions, so the lost lines are not the
 * only record; this notice is here so the failure itself is never invisible.
 */
function announceLogFailure(handle: LogHandle, err: unknown): void {
  if (failureAnnounced.has(handle)) return;
  failureAnnounced.add(handle);
  const notice: LogEntry = {
    time: new Date().toISOString(),
    level: "warn",
    message: "log file unavailable",
    verb: handle.verb,
    stage: "log",
    data: redact({ path: handle.path, error: err instanceof Error ? err.message : String(err) }),
  };
  try {
    process.stderr.write(serialize(notice));
  } catch {
    // give up silently — the observed operation itself must keep running
  }
}

export async function openLog(filePath: string, verb: LogVerb): Promise<LogHandle> {
  const handle: LogHandle = { path: filePath, verb };
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
  } catch (err) {
    // Can't create the log directory — announce once and let appends fall through
    // to the same handling, rather than failing the verb the logger only observes.
    announceLogFailure(handle, err);
  }
  return handle;
}

export async function appendLog(
  handle: LogHandle,
  entry: {
    level: LogLevel;
    stage: LogStage;
    message: string;
    data?: Record<string, unknown>;
    verb?: LogVerb;
    time?: string;
  },
  onEvent?: (entry: LogEntry) => void,
): Promise<void> {
  const final: LogEntry = {
    time: entry.time ?? new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    verb: entry.verb ?? handle.verb,
    stage: entry.stage,
  };
  if (entry.data) final.data = redact(entry.data);

  // Fan out to the live progress sink (the CLI renders it to stderr) before the
  // file write, so a watcher sees the event immediately. Everything but `error`
  // is progress — an error is a failure the caller learns about through the
  // thrown error, not the stream. `debug` stage events (e.g. download ticks) ARE
  // forwarded live; the debug gate below governs only on-disk persistence. A
  // throwing sink must never break logging.
  if (onEvent && final.level !== "error") {
    try {
      onEvent(final);
    } catch {
      // ignore — progress is advisory
    }
  }

  // The developer-only firehose reaches the file only when debug is enabled; it
  // has already been forwarded to the live stream above.
  if (final.level === "debug" && !debugEnabled()) return;

  try {
    await appendFile(handle.path, serialize(final), "utf-8");
  } catch (err) {
    // Logging must never crash the operation it observes. Announce the failure
    // once and keep running; we keep attempting the file on later lines so a
    // transient failure (e.g. a disk that frees up mid-session) self-heals.
    announceLogFailure(handle, err);
  }
}

export async function closeLog(_handle: LogHandle): Promise<void> {
  // No persistent file descriptor in this implementation; nothing to release.
  // Each appendFile opens, appends, and closes, so every line is already on disk
  // — the flush-immediately policy holds without an explicit flush step.
}

export interface Logger {
  readonly handle: LogHandle;
  info(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  warn(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  error(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  debug(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
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
    info: (stage, message, data) => appendLog(handle, { level: "info", stage, message, data }, onEvent),
    warn: (stage, message, data) => appendLog(handle, { level: "warn", stage, message, data }, onEvent),
    error: (stage, message, data) => appendLog(handle, { level: "error", stage, message, data }, onEvent),
    debug: (stage, message, data) => appendLog(handle, { level: "debug", stage, message, data }, onEvent),
    close: () => closeLog(handle),
  };
}

export async function safeLogError(
  logger: Pick<Logger, "error">,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await logger.error("error", message, data);
  } catch {
    // Preserve the original error; logging is best-effort on failure paths.
  }
}
