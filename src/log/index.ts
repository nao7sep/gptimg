import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LogEntry, LogHandle, LogLevel, LogStage, LogVerb } from "../types.js";
import { maskCredentials } from "./mask.js";

/**
 * `debug` logging is a developer-only firehose: it is written to the session log
 * file only when explicitly enabled, so it never floods an end-user's disk
 * (logging-conventions). GptImg ships a single compiled artifact everywhere —
 * there is no separate "dev build" — so the one gate is the `GPTIMG_DEBUG`
 * environment variable. Accept the two forms a human reaches for (`1` / `true`,
 * case- and space-insensitive) so a mis-typed `true` is not a silent no-op. Read
 * per-call so a process that sets it late, or a test that toggles it, is honored.
 */
export function debugEnabled(): boolean {
  const v = process.env.GPTIMG_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true";
}

// Credentials registered for a handle (`Logger.addCredential`). Every record is
// masked against them before any sink receives it, so a key echoed anywhere in a
// request, response or error chain never reaches the file or `onProgress`.
const credentialsByHandle = new WeakMap<LogHandle, Set<string>>();

// Each handle's file writes, chained so lines land in order. Logging is a
// diagnostic sink: a verb never waits for it, so a slow or stalled log disk cannot
// delay a result, a paid image's publication or a cancellation
// (logging-conventions). `closeLog` waits a bounded time for the chain.
const pendingWrites = new WeakMap<LogHandle, Promise<void>>();

// Long enough for an ordinary disk to finish a verb's last lines; short enough
// that a stalled one costs the caller little.
const CLOSE_WAIT_MS = 2_000;

/**
 * Serialize one envelope to a single JSON Lines record (one object,
 * newline-terminated), with the handle's credentials masked. Credentials are
 * matched in their JSON-escaped form, as they appear in the line.
 */
function serialize(handle: LogHandle, entry: LogEntry): string {
  const line = JSON.stringify(entry);
  const credentials = credentialsByHandle.get(handle);
  if (!credentials || credentials.size === 0) return line + "\n";
  return maskCredentials(line, [...credentials].map((c) => JSON.stringify(c).slice(1, -1))) + "\n";
}

function enqueueWrite(handle: LogHandle, line: string, onEvent?: (entry: LogEntry) => void): Promise<void> {
  const next = (pendingWrites.get(handle) ?? Promise.resolve())
    .then(() => appendFile(handle.path, line, { encoding: "utf-8", mode: 0o600 }))
    .catch((err: unknown) => announceLogFailure(handle, err, onEvent));
  pendingWrites.set(handle, next);
  return next;
}

// Handles for which a file-logging failure has already been surfaced. The notice
// goes through the caller's progress sink (`onEvent`) exactly ONCE per session, not
// on every line — and never to a standard stream: an SDK prints nothing, ever
// (sdk-toolkit-conventions, *Output*). With no sink the SDK is silent; the live event
// stream, which is independent of the file, already carries every event. Module-
// private (a WeakSet, not a field) so the public LogHandle stays a plain `{path, verb}`.
const failureAnnounced = new WeakSet<LogHandle>();

/**
 * Surface a log-file failure once per handle, the SDK way: never crash, never
 * print. The notice is one warn-level record forwarded through the caller's
 * progress sink (`onEvent`) — the same envelope a normal line uses — so a watcher
 * learns the on-disk log is unavailable. With no sink the SDK stays silent
 * (sdk-toolkit-conventions, *Output* and *Progress*); the live event stream
 * already carries every non-error event and errors still reach the caller as
 * thrown exceptions, so the file failing loses no part of the contract.
 */
function announceLogFailure(handle: LogHandle, err: unknown, onEvent?: (entry: LogEntry) => void): void {
  if (failureAnnounced.has(handle)) return;
  failureAnnounced.add(handle);
  if (!onEvent) return;
  const notice: LogEntry = {
    time: new Date().toISOString(),
    level: "warn",
    message: "log file unavailable",
    verb: handle.verb,
    stage: "log",
    data: { path: handle.path, error: err instanceof Error ? err.message : String(err) },
  };
  try {
    onEvent(notice);
  } catch {
    // a throwing sink must never break the operation the logger only observes
  }
}

export async function openLog(
  filePath: string,
  verb: LogVerb,
  onEvent?: (entry: LogEntry) => void,
): Promise<LogHandle> {
  const handle: LogHandle = { path: filePath, verb };
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
  } catch (err) {
    // Can't create the log directory — surface once through the sink and let appends
    // fall through to the same handling, rather than failing the verb the logger
    // only observes.
    announceLogFailure(handle, err, onEvent);
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
  if (entry.data) final.data = entry.data;
  let line: string;
  try {
    line = serialize(handle, final);
  } catch (err) {
    // Unserializable data (a cycle, a BigInt) loses this line, never the verb.
    announceLogFailure(handle, err, onEvent);
    return;
  }
  // The progress sink receives the masked copy, never the live objects.
  const event = credentialsByHandle.get(handle)?.size ? (JSON.parse(line) as LogEntry) : final;

  // Fan out to the live progress sink (a caller's `onProgress` handler) before the
  // file write, so a watcher sees the event immediately. Everything but `error`
  // is progress — an error is a failure the caller learns about through the
  // thrown error, not the stream. `debug` stage events (e.g. download ticks) ARE
  // forwarded live; the debug gate below governs only on-disk persistence. A
  // throwing sink must never break logging.
  if (onEvent && final.level !== "error") {
    try {
      onEvent(event);
    } catch {
      // ignore — progress is advisory
    }
  }

  // The developer-only firehose reaches the file only when debug is enabled; it
  // has already been forwarded to the live stream above.
  if (final.level === "debug" && !debugEnabled()) return;

  // Logging must never crash the operation it observes: a failed write is
  // surfaced once (through the sink), and later lines keep trying the file so a
  // transient failure self-heals. The returned promise settles when this line is
  // written or has failed; the verb logger does not wait for it.
  await enqueueWrite(handle, line, onEvent);
}

/** Mask `credential` in every later record of this handle. */
export function addLogCredential(handle: LogHandle, credential: string): void {
  if (credential.length === 0) return;
  const credentials = credentialsByHandle.get(handle) ?? new Set<string>();
  credentials.add(credential);
  credentialsByHandle.set(handle, credentials);
}

/**
 * Wait for the handle's pending writes, at most `CLOSE_WAIT_MS`, so a caller
 * that reads the log after a verb returns finds its lines, while a stalled log
 * disk cannot hold the verb. Each write opens, appends and closes the file, so
 * there is no descriptor to release.
 */
export async function closeLog(handle: LogHandle): Promise<void> {
  const pending = pendingWrites.get(handle);
  if (!pending) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_WAIT_MS);
    timer.unref();
  });
  await Promise.race([pending, timeout]);
  clearTimeout(timer);
}

/**
 * A verb's logger. Each record reaches `onEvent` at once and is queued for the
 * file in order; the returned promises settle without waiting for the disk, and
 * `close` waits a bounded time for the queue.
 */
export interface Logger {
  readonly handle: LogHandle;
  info(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  warn(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  error(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  debug(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  /** Mask `credential` (an API key) in every later record, file and `onEvent` alike. */
  addCredential(credential: string): void;
  close(): Promise<void>;
}

export async function createLogger(
  filePath: string,
  verb: LogVerb,
  opts: { onEvent?: (entry: LogEntry) => void } = {},
): Promise<Logger> {
  const onEvent = opts.onEvent;
  const handle = await openLog(filePath, verb, onEvent);
  const record = (level: LogLevel, stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void> => {
    void appendLog(handle, { level, stage, message, data }, onEvent);
    return Promise.resolve();
  };
  return {
    handle,
    info: (stage, message, data) => record("info", stage, message, data),
    warn: (stage, message, data) => record("warn", stage, message, data),
    error: (stage, message, data) => record("error", stage, message, data),
    debug: (stage, message, data) => record("debug", stage, message, data),
    addCredential: (credential) => addLogCredential(handle, credential),
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
